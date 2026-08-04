import { describe, expect, it } from 'vitest';
import { createInvoiceSchema, createTaxNoteSchema } from '../invoice.schema';
import { allocatePaymentSchema, createPaymentSchema, writeOffSchema } from '../payment.schema';
import { gstReturnQuerySchema, toReturnPeriod } from '../gst-return.schema';

/**
 * The DTO refusals. These exist to stop a malformed request becoming a legal
 * document, so each test names the failure it prevents rather than the rule it
 * checks.
 */

const PRODUCT = '019fcc4b-0000-7000-8000-000000000001';
const DIST = '019fcaa4-0000-7000-8000-000000000002';
const CUST = '019fccee-0000-7000-8000-000000000003';
const INVOICE = '019fcddc-0000-7000-8000-000000000004';

describe('createInvoiceSchema', () => {
  it('accepts a direct invoice addressed to one party', () => {
    const result = createInvoiceSchema.safeParse({
      distributorId: DIST,
      lines: [{ productId: PRODUCT, quantity: '2' }],
    });
    expect(result.success).toBe(true);
  });

  it('refuses an invoice addressed to nobody — it can be neither sent nor aged', () => {
    const result = createInvoiceSchema.safeParse({
      lines: [{ productId: PRODUCT, quantity: '2' }],
    });
    expect(result.success).toBe(false);
  });

  it('refuses an invoice addressed to BOTH a distributor and a customer', () => {
    // Mirrors `invoice_exactly_one_counterparty` in migration 0010 — a
    // receivable that belongs to two parties cannot be collected from either.
    const result = createInvoiceSchema.safeParse({
      distributorId: DIST,
      customerId: CUST,
      lines: [{ productId: PRODUCT, quantity: '2' }],
    });
    expect(result.success).toBe(false);
  });

  it('has no field through which a client could post a price', () => {
    // ADR-0007: if a client could post a price, the pricing engine would be
    // advisory and every discount ceiling trivially bypassable.
    const parsed = createInvoiceSchema.safeParse({
      distributorId: DIST,
      lines: [{ productId: PRODUCT, quantity: '2', unitPrice: '1.00' }],
    });
    expect(parsed.success).toBe(true);
    const line = parsed.success ? parsed.data.lines[0] : undefined;
    expect(line && 'unitPrice' in line).toBe(false);
  });

  it('has no field through which a client could post an invoice NUMBER', () => {
    // The statutory series is allocated server-side inside the issue
    // transaction. A client-supplied number would gap the series the first time
    // a request failed after allocation.
    const parsed = createInvoiceSchema.safeParse({
      distributorId: DIST,
      number: 'HTPL/INV/2026-27/09999',
      lines: [{ productId: PRODUCT, quantity: '1' }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'number' in parsed.data).toBe(false);
  });
});

describe('createPaymentSchema', () => {
  const base = { distributorId: DIST, method: 'NEFT' as const, amount: '1000.00' };

  it('accepts a plain receipt', () => {
    expect(createPaymentSchema.safeParse(base).success).toBe(true);
  });

  it('refuses a receipt from two parties at once', () => {
    expect(
      createPaymentSchema.safeParse({ ...base, customerId: CUST }).success,
    ).toBe(false);
  });

  it('refuses a zero receipt — a non-event recorded as if it were one', () => {
    expect(createPaymentSchema.safeParse({ ...base, amount: '0' }).success).toBe(false);
  });

  it('requires a cheque number, because that is what verification matches on', () => {
    const withoutNumber = createPaymentSchema.safeParse({
      ...base,
      method: 'CHEQUE',
    });
    expect(withoutNumber.success).toBe(false);

    const withNumber = createPaymentSchema.safeParse({
      ...base,
      method: 'CHEQUE',
      chequeNumber: '445566',
    });
    expect(withNumber.success).toBe(true);
  });

  it('refuses allocations that exceed the receipt, INCLUDING its TDS', () => {
    // 900 cash + 100 TDS = 1,000 allocatable. 1,200 is not.
    const result = createPaymentSchema.safeParse({
      distributorId: DIST,
      method: 'NEFT',
      amount: '900.00',
      tdsAmount: '100.00',
      allocations: [{ invoiceId: INVOICE, amount: '1200.00' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts allocations that exactly consume cash plus TDS', () => {
    const result = createPaymentSchema.safeParse({
      distributorId: DIST,
      method: 'NEFT',
      amount: '900.00',
      tdsAmount: '100.00',
      allocations: [{ invoiceId: INVOICE, amount: '1000.00' }],
    });
    expect(result.success).toBe(true);
  });

  it('refuses the same invoice twice in one allocation set', () => {
    const result = createPaymentSchema.safeParse({
      ...base,
      amount: '1000.00',
      allocations: [
        { invoiceId: INVOICE, amount: '400.00' },
        { invoiceId: INVOICE, amount: '400.00' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('has no status field — recording cannot verify in one step (ADR-0018)', () => {
    const parsed = createPaymentSchema.safeParse({ ...base, status: 'VERIFIED' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'status' in parsed.data).toBe(false);
  });

  it('has no verifiedById — the verifier is the caller, never the body', () => {
    // Accepting it would let one person record a receipt and name someone else
    // as the verifier: the control read backwards.
    const parsed = createPaymentSchema.safeParse({ ...base, verifiedById: DIST });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'verifiedById' in parsed.data).toBe(false);
  });
});

describe('allocatePaymentSchema', () => {
  it('refuses an empty allocation set', () => {
    expect(allocatePaymentSchema.safeParse({ allocations: [] }).success).toBe(false);
  });

  it('refuses a zero or negative allocation', () => {
    expect(
      allocatePaymentSchema.safeParse({ allocations: [{ invoiceId: INVOICE, amount: '0' }] })
        .success,
    ).toBe(false);
    expect(
      allocatePaymentSchema.safeParse({ allocations: [{ invoiceId: INVOICE, amount: '-5' }] })
        .success,
    ).toBe(false);
  });
});

describe('createTaxNoteSchema', () => {
  it('requires the invoice being corrected', () => {
    // A note that references nothing is not a correction, and GSTR-1 9B has
    // nowhere to put it.
    const result = createTaxNoteSchema.safeParse({
      reason: 'SALES_RETURN',
      lines: [{ description: 'Returned', taxableValue: '100.00' }],
    });
    expect(result.success).toBe(false);
  });

  it('requires a statutory reason code rather than free text', () => {
    const result = createTaxNoteSchema.safeParse({
      originalInvoiceId: INVOICE,
      reason: 'customer changed their mind',
      lines: [{ description: 'Returned', taxableValue: '100.00' }],
    });
    expect(result.success).toBe(false);
  });

  it('has no gstRate field — the rate is copied from the invoice line', () => {
    // A note taxed at a different rate from the supply it corrects is a
    // mismatch the portal rejects.
    const parsed = createTaxNoteSchema.safeParse({
      originalInvoiceId: INVOICE,
      reason: 'RATE_DIFFERENCE',
      lines: [{ description: 'Correction', taxableValue: '100.00', gstRate: '5' }],
    });
    expect(parsed.success).toBe(true);
    const line = parsed.success ? parsed.data.lines[0] : undefined;
    expect(line && 'gstRate' in line).toBe(false);
  });
});

describe('writeOffSchema', () => {
  it('demands an explanation — it is money the company will not collect', () => {
    expect(
      writeOffSchema.safeParse({
        partyType: 'DISTRIBUTOR',
        partyId: DIST,
        amount: '5000.00',
        reason: 'bad',
      }).success,
    ).toBe(false);

    expect(
      writeOffSchema.safeParse({
        partyType: 'DISTRIBUTOR',
        partyId: DIST,
        amount: '5000.00',
        reason: 'Partner in liquidation; recovery abandoned on counsel’s advice.',
      }).success,
    ).toBe(true);
  });
});

describe('gstReturnQuerySchema', () => {
  it('refuses a reversed period', () => {
    expect(gstReturnQuerySchema.safeParse({ from: '2026-08-01', to: '2026-04-01' }).success).toBe(
      false,
    );
  });

  it('accepts a normal period', () => {
    expect(gstReturnQuerySchema.safeParse({ from: '2026-04-01', to: '2026-06-30' }).success).toBe(
      true,
    );
  });

  it('formats the return period the way the portal expects', () => {
    expect(toReturnPeriod('2026-04-01')).toBe('042026');
    expect(toReturnPeriod('2026-12-31')).toBe('122026');
  });
});
