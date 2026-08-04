import { describe, expect, it } from 'vitest';
import {
  DISTRIBUTOR_TRANSITIONS,
  REQUIRED_KYC_FOR_APPROVAL,
  canTransact,
  canTransitionDistributor,
  createDistributorSchema,
  updateCreditLimitSchema,
} from '../distributor.schema';
import { DISTRIBUTOR_STATUSES, type DistributorStatus } from '../../enums';

/**
 * The distributor lifecycle decides whether a partner can transact at all, so
 * an illegal transition is a commercial control failure, not a UI glitch.
 */
describe('distributor lifecycle', () => {
  it('follows the documented happy path', () => {
    expect(canTransitionDistributor('LEAD', 'PENDING_APPROVAL')).toBe(true);
    expect(canTransitionDistributor('PENDING_APPROVAL', 'ACTIVE')).toBe(true);
    expect(canTransitionDistributor('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(canTransitionDistributor('SUSPENDED', 'ACTIVE')).toBe(true);
  });

  it('refuses to activate a LEAD directly', () => {
    // Skipping PENDING_APPROVAL would bypass the KYC gate entirely.
    expect(canTransitionDistributor('LEAD', 'ACTIVE')).toBe(false);
    expect(canTransitionDistributor('LEAD', 'SUSPENDED')).toBe(false);
  });

  it('treats TERMINATED as terminal', () => {
    expect(DISTRIBUTOR_TRANSITIONS.TERMINATED).toHaveLength(0);
    for (const status of DISTRIBUTOR_STATUSES) {
      expect(canTransitionDistributor('TERMINATED', status)).toBe(false);
    }
  });

  it('allows termination from any non-terminal state', () => {
    for (const status of DISTRIBUTOR_STATUSES.filter((s) => s !== 'TERMINATED')) {
      expect(canTransitionDistributor(status, 'TERMINATED')).toBe(true);
    }
  });

  it('never declares a transition to a status outside the enum', () => {
    const known = new Set<DistributorStatus>(DISTRIBUTOR_STATUSES);
    for (const targets of Object.values(DISTRIBUTOR_TRANSITIONS)) {
      for (const target of targets) expect(known.has(target)).toBe(true);
    }
  });

  it('permits transacting only when ACTIVE', () => {
    for (const status of DISTRIBUTOR_STATUSES) {
      expect(canTransact(status)).toBe(status === 'ACTIVE');
    }
  });

  it('requires GST, PAN, and an agreement before approval', () => {
    expect([...REQUIRED_KYC_FOR_APPROVAL]).toEqual([
      'GST_CERTIFICATE',
      'PAN_CARD',
      'AGREEMENT',
    ]);
  });
});

describe('createDistributorSchema', () => {
  const base = { legalName: 'Vidarbha Automation LLP' };

  it('accepts a minimal distributor', () => {
    const parsed = createDistributorSchema.parse(base);
    expect(parsed.type).toBe('DISTRIBUTOR');
    expect(parsed.creditLimit).toBe('0.0000');
    expect(parsed.creditDays).toBe(30);
  });

  it('validates the GSTIN check digit', () => {
    expect(createDistributorSchema.safeParse({ ...base, gstin: '27AAPFU0939F1ZV' }).success).toBe(
      true,
    );
    // One wrong final character.
    expect(createDistributorSchema.safeParse({ ...base, gstin: '27AAPFU0939F1ZX' }).success).toBe(
      false,
    );
  });

  it('rejects a PAN that disagrees with the GSTIN', () => {
    // A GSTIN embeds its holder's PAN at characters 3–12. If both are supplied
    // and they differ, one is a typo — and the resulting invoice would be wrong.
    const result = createDistributorSchema.safeParse({
      ...base,
      gstin: '27AAPFU0939F1ZV',
      pan: 'ZZZZZ9999Z',
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['pan']);
  });

  it('accepts a PAN that matches the GSTIN', () => {
    expect(
      createDistributorSchema.safeParse({
        ...base,
        gstin: '27AAPFU0939F1ZV',
        pan: 'AAPFU0939F',
      }).success,
    ).toBe(true);
  });

  it('rejects a negative credit limit', () => {
    expect(createDistributorSchema.safeParse({ ...base, creditLimit: '-1' }).success).toBe(false);
  });

  it('normalises money to a 4-decimal string, never a number', () => {
    const parsed = createDistributorSchema.parse({ ...base, creditLimit: '500000' });
    expect(parsed.creditLimit).toBe('500000.0000');
    expect(typeof parsed.creditLimit).toBe('string');
  });

  it('rejects a malformed IFSC', () => {
    expect(createDistributorSchema.safeParse({ ...base, bankIfsc: 'HDFC1001234' }).success).toBe(
      false,
    );
    expect(createDistributorSchema.safeParse({ ...base, bankIfsc: 'HDFC0001234' }).success).toBe(
      true,
    );
  });
});

describe('updateCreditLimitSchema', () => {
  it('requires a reason', () => {
    // The limit is what stands between the company and unrecoverable exposure;
    // a change with no stated reason is not auditable after the fact.
    expect(updateCreditLimitSchema.safeParse({ creditLimit: '100000' }).success).toBe(false);
    expect(updateCreditLimitSchema.safeParse({ creditLimit: '100000', reason: 'ok' }).success).toBe(
      false,
    );
    expect(
      updateCreditLimitSchema.safeParse({
        creditLimit: '100000',
        reason: 'Q3 volume commitment',
      }).success,
    ).toBe(true);
  });
});
