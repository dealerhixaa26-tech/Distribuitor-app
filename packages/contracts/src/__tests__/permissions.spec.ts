import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  findSegregationViolations,
  parsePermission,
} from '../permissions';
import { ORDER_TRANSITIONS, canTransitionOrder, type OrderStatus } from '../enums';

describe('permission catalogue', () => {
  it('has no duplicate keys', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('uses the resource:action convention throughout', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(permission).toMatch(/^[a-z]+(:[a-z-]+)+$/);
      const { resource, action } = parsePermission(permission);
      expect(resource).not.toBe('');
      expect(action).not.toBe('');
    }
  });
});

describe('segregation of duties', () => {
  it('flags a role that can both record and verify a payment', () => {
    const violations = findSegregationViolations([
      PERMISSIONS.PAYMENT_CREATE,
      PERMISSIONS.PAYMENT_VERIFY,
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toMatch(/must not be the person who confirms/);
  });

  it('flags a role that can both create and approve an order', () => {
    expect(
      findSegregationViolations([PERMISSIONS.ORDER_CREATE, PERMISSIONS.ORDER_APPROVE]),
    ).toHaveLength(1);
  });

  it('allows either half of a separated pair on its own', () => {
    expect(findSegregationViolations([PERMISSIONS.PAYMENT_CREATE])).toHaveLength(0);
    expect(findSegregationViolations([PERMISSIONS.PAYMENT_VERIFY])).toHaveLength(0);
  });
});

describe('order state machine', () => {
  it('permits only declared transitions', () => {
    expect(canTransitionOrder('DRAFT', 'PENDING_APPROVAL')).toBe(true);
    expect(canTransitionOrder('APPROVED', 'PROCESSING')).toBe(true);
    expect(canTransitionOrder('DELIVERED', 'DRAFT')).toBe(false);
    expect(canTransitionOrder('COMPLETED', 'CANCELLED')).toBe(false);
  });

  it('treats COMPLETED and CANCELLED as terminal', () => {
    expect(ORDER_TRANSITIONS.COMPLETED).toHaveLength(0);
    expect(ORDER_TRANSITIONS.CANCELLED).toHaveLength(0);
  });

  it('never transitions to a status outside the enum', () => {
    const known = new Set(Object.keys(ORDER_TRANSITIONS) as OrderStatus[]);
    for (const targets of Object.values(ORDER_TRANSITIONS)) {
      for (const target of targets) expect(known.has(target)).toBe(true);
    }
  });

  it('cannot cancel an order that has already shipped', () => {
    // Once goods have left the warehouse, the correction path is a return,
    // not a cancellation — the machine enforces that.
    expect(canTransitionOrder('DISPATCHED', 'CANCELLED')).toBe(false);
    expect(canTransitionOrder('DELIVERED', 'CANCELLED')).toBe(false);
  });
});
