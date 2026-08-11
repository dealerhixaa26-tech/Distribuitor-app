import { describe, expect, it } from 'vitest';
import { get, set } from 'react-hook-form';
import { ApiError } from './api-client';
import { applyServerErrors, lineFields, toFieldPath } from './form-errors';
import { pruneEmpty } from './use-entity-mutation';

/**
 * These assert that a server refusal REACHES a field — never merely that the
 * bridge ran. A test of the second kind passes against a bridge that files
 * every message under a key nothing reads, which is exactly the defect worth
 * catching (HANDOFF §2).
 */

const problem = (errors: { field: string; message: string }[]) =>
  new ApiError(
    {
      type: 'about:blank',
      title: 'Validation',
      status: 422,
      detail: 'One or more fields are invalid.',
      code: 'VALIDATION_FAILED',
      errors: errors.map((error) => ({ ...error, code: 'CUSTOM' })),
    },
    422,
  );

/** Records what `setError` was asked to do, and where it landed. */
function recordingSetError() {
  const errors: Record<string, unknown> = {};
  const calls: string[] = [];
  const setError = ((name: string, value: unknown) => {
    calls.push(name);
    // The same primitive React Hook Form uses internally, so the assertion is
    // about where the message really goes rather than about our own bookkeeping.
    set(errors, name, value);
  }) as never;
  return { errors, calls, setError };
}

describe('React Hook Form path resolution', () => {
  // Pinned against the INSTALLED version. The bridge's string comparison is
  // only sound while these two remain interchangeable to RHF; if a future
  // version stops splitting on brackets, this fails and says so.
  it('resolves bracket and dotted array paths to the same field', () => {
    const bracket = {};
    const dotted = {};
    set(bracket, 'lines[0].productId', 'value');
    set(dotted, 'lines.0.productId', 'value');

    expect(bracket).toEqual(dotted);
    expect(get(bracket, 'lines.0.productId')).toBe('value');
  });
});

describe('toFieldPath', () => {
  it('canonicalises array indices to the dotted form', () => {
    expect(toFieldPath('lines[0].productId')).toBe('lines.0.productId');
    expect(toFieldPath('allocations[12].amount')).toBe('allocations.12.amount');
  });

  it('leaves an already-canonical nested path alone', () => {
    expect(toFieldPath('billingAddress.line1')).toBe('billingAddress.line1');
    expect(toFieldPath('legalName')).toBe('legalName');
  });
});

describe('applyServerErrors', () => {
  it('places a nested object error on the field that owns it', () => {
    const { errors, setError } = recordingSetError();

    applyServerErrors(
      problem([{ field: 'billingAddress.line1', message: 'Required' }]),
      setError,
      ['legalName', 'billingAddress.line1'],
    );

    // Read back the way a form does — not by inspecting the call log.
    expect(get(errors, 'billingAddress.line1')).toMatchObject({ message: 'Required' });
  });

  it('places a line error on the line, addressed either way', () => {
    const { errors, setError } = recordingSetError();

    const result = applyServerErrors(
      problem([
        { field: 'lines[0].productId', message: 'Must be a valid UUID' },
        { field: 'lines[1].quantity', message: 'Quantity must be greater than zero' },
      ]),
      setError,
      lineFields('lines', 2, ['productId', 'quantity']),
    );

    expect(get(errors, 'lines.0.productId')).toMatchObject({ message: 'Must be a valid UUID' });
    expect(get(errors, 'lines[1].quantity')).toMatchObject({
      message: 'Quantity must be greater than zero',
    });
    expect(result.unattributed).toEqual([]);
  });

  it('reports an error naming a field the form does not render, rather than dropping it', () => {
    const { errors, calls, setError } = recordingSetError();

    const result = applyServerErrors(
      problem([{ field: 'openingBalance', message: 'Cannot be negative' }]),
      setError,
      ['legalName'],
    );

    // Nothing was written, and nothing was lost: it surfaces in the summary.
    expect(calls).toEqual([]);
    expect(errors).toEqual({});
    expect(result.unattributed).toEqual(['openingBalance: Cannot be negative']);
  });

  it('keeps the server detail as the form-level summary', () => {
    const { setError } = recordingSetError();
    const result = applyServerErrors(problem([]), setError, []);
    expect(result.summary).toBe('One or more fields are invalid.');
  });

  it('degrades to a reachability message when the failure is not an ApiError', () => {
    const { setError } = recordingSetError();
    const result = applyServerErrors(new TypeError('fetch failed'), setError, ['legalName']);
    expect(result.summary).toContain('Could not reach the server');
    expect(result.unattributed).toEqual([]);
  });
});

describe('lineFields', () => {
  it('expands one entry per row per field', () => {
    expect(lineFields('lines', 2, ['productId', 'quantity'])).toEqual([
      'lines.0.productId',
      'lines.0.quantity',
      'lines.1.productId',
      'lines.1.quantity',
    ]);
  });

  it('expands to nothing when there are no rows', () => {
    expect(lineFields('lines', 0, ['productId'])).toEqual([]);
  });
});

describe('pruneEmpty', () => {
  it('drops empty strings, nulls, undefined and NaN', () => {
    expect(pruneEmpty({ a: 'x', b: '', c: null, d: undefined, e: Number.NaN })).toEqual({ a: 'x' });
  });

  it('drops a nested object that is entirely empty, rather than posting {}', () => {
    // A blank shipping address must not reach `addressSchema`, whose required
    // fields would refuse it.
    expect(pruneEmpty({ name: 'x', shippingAddress: { line1: '', cityName: '' } })).toEqual({
      name: 'x',
    });
  });

  it('recurses INTO array elements', () => {
    // The defect this exists for: a line's untouched `notes` is '' and
    // `mediumTextSchema` refuses it, so every quotation was rejected for a note
    // nobody wrote.
    expect(
      pruneEmpty({ lines: [{ productId: 'p1', quantity: '3', notes: '', override: '' }] }),
    ).toEqual({ lines: [{ productId: 'p1', quantity: '3' }] });
  });

  it('preserves array POSITION, because a server error path refers to the index', () => {
    const pruned = pruneEmpty({
      lines: [
        { productId: 'a', notes: '' },
        { productId: '', notes: '' },
        { productId: 'c', notes: 'keep' },
      ],
    }) as { lines: unknown[] };

    expect(pruned.lines).toHaveLength(3);
    expect(pruned.lines[1]).toEqual({});
    expect(pruned.lines[2]).toEqual({ productId: 'c', notes: 'keep' });
  });

  it('leaves primitive arrays alone', () => {
    expect(pruneEmpty({ tags: ['a', 'b'] })).toEqual({ tags: ['a', 'b'] });
  });
});
