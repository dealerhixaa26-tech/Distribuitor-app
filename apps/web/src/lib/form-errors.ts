import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError, toFieldPath } from './api-client';

export { toFieldPath };

/**
 * Bridges a server refusal onto the form fields that caused it.
 *
 * The failure this guards against is not a path mismatch — React Hook Form
 * resolves `lines[0].productId` and `lines.0.productId` to the same field, and
 * `form-errors.spec.ts` pins that against the installed version.
 *
 * It is that `setError` accepts ANY name. An error naming a field the form does
 * not render — a rule about a column the UI never exposes, or a field a
 * narrower edit form omits — is stored somewhere nothing reads. The form
 * refuses to submit and shows the user nothing, so the button appears to do
 * nothing at all. That is the shape of defect this codebase keeps finding
 * (HANDOFF §2): not a crash, but something succeeding while doing nothing.
 *
 * So every error is either placed on a field the form declares, or returned in
 * `unattributed` for the caller to show in the form-level summary. A refusal is
 * never silently dropped.
 */
export function applyServerErrors<TValues extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<TValues>,
  knownFields: readonly string[],
): { summary: string; unattributed: string[] } {
  if (!(error instanceof ApiError)) {
    return { summary: 'Could not reach the server. Please try again.', unattributed: [] };
  }

  const unattributed: string[] = [];
  // Both sides are canonical dotted paths: `fieldErrors` normalises on the way
  // out, and `knownFields` comes from the form's own field list. String
  // equality is only sound because of that.
  const known = new Set(knownFields);

  for (const [path, message] of Object.entries(error.fieldErrors)) {
    if (known.has(path)) {
      setError(path as Path<TValues>, { type: 'server', message });
    } else {
      unattributed.push(`${path}: ${message}`);
    }
  }

  return { summary: error.problem.detail || error.problem.title, unattributed };
}

/**
 * Expands a line-array field prefix for `knownFields`.
 *
 * A form with three lines declares `lines.0.quantity`, `lines.1.quantity`, and
 * so on. Written by hand that list goes stale the moment a row is added, and a
 * stale list turns a real error into an unattributed one.
 */
export function lineFields(prefix: string, count: number, fields: readonly string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < count; index += 1) {
    for (const field of fields) output.push(`${prefix}.${index}.${field}`);
  }
  return output;
}
