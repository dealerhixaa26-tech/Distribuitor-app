import { describe, expect, it } from 'vitest';
import {
  AGING_BUCKETS,
  LEDGER_ENTRY_SIDES,
  LEDGER_ENTRY_TYPES,
  OUTSTANDING_INVOICE_STATUSES,
  agingBucketFor,
  canTransitionInvoice,
  isOverdue,
  type LedgerEntryType,
} from '../../enums';
import { bucketForInvoice, daysPastDue } from '../ledger.schema';

/**
 * The sign convention, asserted.
 *
 * ADR-0015 §3 states it once in prose: DEBIT increases what the party owes
 * Hixaa. Prose is not enough — a sign convention that lives only in people's
 * heads inverts itself within a year, usually inside one report while the others
 * still use the old one. This file is the record.
 */
describe('ledger sign convention (ADR-0015 §3)', () => {
  it('debits what increases the receivable', () => {
    // An invoice bills them; a debit note bills them more. Both increase what
    // they owe, so both DEBIT.
    expect(LEDGER_ENTRY_SIDES.INVOICE).toBe('DEBIT');
    expect(LEDGER_ENTRY_SIDES.DEBIT_NOTE).toBe('DEBIT');
  });

  it('credits what reduces the receivable', () => {
    expect(LEDGER_ENTRY_SIDES.PAYMENT).toBe('CREDIT');
    expect(LEDGER_ENTRY_SIDES.CREDIT_NOTE).toBe('CREDIT');
    // TDS reduces what is still collectable from the party even though no cash
    // arrived — it is recoverable from the government instead (ADR-0018 §4).
    expect(LEDGER_ENTRY_SIDES.TDS).toBe('CREDIT');
    expect(LEDGER_ENTRY_SIDES.WRITE_OFF).toBe('CREDIT');
  });

  it('allows either side only where direction is genuinely the operator’s call', () => {
    expect(LEDGER_ENTRY_SIDES.OPENING_BALANCE).toBe('EITHER');
    expect(LEDGER_ENTRY_SIDES.ADJUSTMENT).toBe('EITHER');
  });

  it('assigns a side to every entry type — a new type cannot be forgotten', () => {
    for (const type of LEDGER_ENTRY_TYPES) {
      expect(LEDGER_ENTRY_SIDES[type as LedgerEntryType]).toBeDefined();
    }
    expect(Object.keys(LEDGER_ENTRY_SIDES).sort()).toEqual([...LEDGER_ENTRY_TYPES].sort());
  });

  it('a running balance built from the table lands where hand-arithmetic does', () => {
    // The Phase 8 verification run, reproduced: one invoice, a part payment with
    // TDS, and a credit note.
    const entries: Array<[LedgerEntryType, number]> = [
      ['INVOICE', 991_200],
      ['PAYMENT', 490_000],
      ['TDS', 10_000],
      ['CREDIT_NOTE', 91_200],
    ];

    const balance = entries.reduce(
      (total, [type, amount]) =>
        LEDGER_ENTRY_SIDES[type] === 'DEBIT' ? total + amount : total - amount,
      0,
    );

    expect(balance).toBe(400_000);
  });
});

describe('aging (docs/23 §8)', () => {
  it('measures from the DUE date, so Net 45 terms are not overdue on day 31', () => {
    // 2026-08-04 against a due date of 2026-09-03 — thirty days of credit left.
    const asOf = new Date('2026-08-04T00:00:00.000Z');
    expect(daysPastDue('2026-09-03', asOf)).toBe(-30);
    expect(bucketForInvoice('2026-09-03', asOf)).toBe('CURRENT');
  });

  it('places a 45-day-late invoice in 31–60', () => {
    const asOf = new Date('2026-08-04T00:00:00.000Z');
    expect(daysPastDue('2026-06-20', asOf)).toBe(45);
    expect(bucketForInvoice('2026-06-20', asOf)).toBe('D31_60');
  });

  it('puts the bucket boundaries where the labels say they are', () => {
    expect(agingBucketFor(0)).toBe('CURRENT');
    expect(agingBucketFor(1)).toBe('D0_30');
    expect(agingBucketFor(30)).toBe('D0_30');
    expect(agingBucketFor(31)).toBe('D31_60');
    expect(agingBucketFor(60)).toBe('D31_60');
    expect(agingBucketFor(61)).toBe('D61_90');
    expect(agingBucketFor(90)).toBe('D61_90');
    expect(agingBucketFor(91)).toBe('D90_PLUS');
  });

  it('treats an invoice with no due date as never overdue', () => {
    // Payment terms are optional; "on receipt" is not a date, and inventing one
    // would age an invoice nobody agreed a deadline for.
    expect(daysPastDue(null)).toBe(0);
    expect(bucketForInvoice(null)).toBe('CURRENT');
  });

  it('compares whole DAYS, not instants — the IST offset must not shift a bucket', () => {
    // An invoice due "on the 30th" is due on the 30th in Nagpur. Subtracting
    // timestamps would make it overdue at 18:30 IST on the 29th.
    const lateOnDueDate = new Date('2026-06-20T23:59:00.000Z');
    expect(daysPastDue('2026-06-20', lateOnDueDate)).toBe(0);
    expect(bucketForInvoice('2026-06-20', lateOnDueDate)).toBe('CURRENT');
  });

  it('exposes every bucket the report renders', () => {
    expect(AGING_BUCKETS).toEqual(['CURRENT', 'D0_30', 'D31_60', 'D61_90', 'D90_PLUS']);
  });
});

describe('overdue is computed, never stored (docs/23 §5)', () => {
  const asOf = new Date('2026-08-04T00:00:00.000Z');

  it('is true only when the date has passed AND money is still owed', () => {
    expect(
      isOverdue({ dueDate: '2026-06-20', amountOutstanding: '99120.0000', status: 'ISSUED', asOf }),
    ).toBe(true);
  });

  it('is false once the invoice is settled, whatever the date says', () => {
    expect(
      isOverdue({ dueDate: '2026-06-20', amountOutstanding: '0.0000', status: 'PAID', asOf }),
    ).toBe(false);
  });

  it('is false for a draft — it has not been issued and owes nothing', () => {
    expect(
      isOverdue({ dueDate: '2026-01-01', amountOutstanding: '5000.0000', status: 'DRAFT', asOf }),
    ).toBe(false);
  });

  it('is false for a cancelled invoice', () => {
    expect(
      isOverdue({
        dueDate: '2026-01-01',
        amountOutstanding: '5000.0000',
        status: 'CANCELLED',
        asOf,
      }),
    ).toBe(false);
  });
});

describe('invoice lifecycle', () => {
  it('issues only from DRAFT — a statutory number is consumed exactly once', () => {
    expect(canTransitionInvoice('DRAFT', 'ISSUED')).toBe(true);
    expect(canTransitionInvoice('ISSUED', 'ISSUED')).toBe(false);
  });

  /**
   * `PAID → ISSUED` is legal, and that reads oddly until you see why.
   *
   * The table describes STATUS movements, not the issue ACTION. A credit note
   * that offsets everything paid leaves an invoice issued and unsettled again,
   * so the status has to be able to travel back. Re-issuing — allocating a
   * second statutory number — is refused by `InvoicesService.issue()` on
   * `status !== 'DRAFT'`, which is a separate control from this table.
   */
  it('lets a credit note reopen a PAID invoice, so PAID is not terminal', () => {
    expect(canTransitionInvoice('PAID', 'PARTIALLY_PAID')).toBe(true);
    expect(canTransitionInvoice('PAID', 'ISSUED')).toBe(true);
  });

  it('makes CANCELLED terminal — the number is retained, never reissued', () => {
    expect(canTransitionInvoice('CANCELLED', 'ISSUED')).toBe(false);
    expect(canTransitionInvoice('CANCELLED', 'DRAFT')).toBe(false);
  });

  it('refuses to cancel a settled invoice through the state machine', () => {
    // The service adds the narrower rules (no allocations, no notes, same FY);
    // this is only the shape.
    expect(canTransitionInvoice('ISSUED', 'CANCELLED')).toBe(true);
    expect(canTransitionInvoice('PAID', 'CANCELLED')).toBe(false);
  });

  it('counts only ISSUED and PARTIALLY_PAID as outstanding', () => {
    // Shared by the aging report and the credit check — they must not disagree
    // about what "outstanding" means.
    expect([...OUTSTANDING_INVOICE_STATUSES]).toEqual(['ISSUED', 'PARTIALLY_PAID']);
    expect(OUTSTANDING_INVOICE_STATUSES).not.toContain('DRAFT');
    expect(OUTSTANDING_INVOICE_STATUSES).not.toContain('CANCELLED');
    expect(OUTSTANDING_INVOICE_STATUSES).not.toContain('PAID');
  });
});
