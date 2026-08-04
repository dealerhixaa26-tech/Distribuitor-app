import { describe, expect, it } from 'vitest';
import { buildCategoryTree, type CategoryTreeFields } from '../category.schema';
import {
  PRODUCT_TRANSITIONS,
  canTransitionProduct,
  createProductSchema,
} from '../product.schema';
import {
  canTransitionPriceList,
  createDiscountRuleSchema,
  priceOverrideSchema,
  quoteRequestSchema,
} from '../pricing.schema';
import { PRODUCT_STATUSES, type ProductStatus } from '../../enums';

/**
 * The tax-classification rule is enforced in three places on purpose — here,
 * in ProductsService, and as a CHECK constraint in migration 0006. This suite
 * pins the first of the three. A service invoiced under an HSN code is a GST
 * filing defect that only surfaces at return time.
 */
describe('product tax classification', () => {
  const base = { sku: 'HTPL-TEST-1', name: 'Test' };

  it('accepts goods classified by HSN', () => {
    const result = createProductSchema.safeParse({ ...base, type: 'GOODS', hsnCode: '85176290' });
    expect(result.success).toBe(true);
  });

  it('accepts a service classified by SAC', () => {
    const result = createProductSchema.safeParse({ ...base, type: 'SERVICE', sacCode: '998719' });
    expect(result.success).toBe(true);
  });

  it('refuses a product carrying BOTH an HSN and a SAC', () => {
    const result = createProductSchema.safeParse({
      ...base,
      type: 'GOODS',
      hsnCode: '85176290',
      sacCode: '998719',
    });
    expect(result.success).toBe(false);
  });

  it('refuses a SERVICE classified by HSN, naming the offending field', () => {
    const result = createProductSchema.safeParse({
      ...base,
      type: 'SERVICE',
      hsnCode: '85176290',
    });
    expect(result.success).toBe(false);
    // The error must attach to the field so a form can render it in place,
    // rather than reporting a bare "invalid input" at the form root.
    expect(result.error?.issues.some((i) => i.path.includes('hsnCode'))).toBe(true);
  });

  it('refuses goods classified by SAC', () => {
    const result = createProductSchema.safeParse({ ...base, type: 'GOODS', sacCode: '998719' });
    expect(result.success).toBe(false);
  });

  it('refuses a SAC that does not begin with 99', () => {
    const result = createProductSchema.safeParse({ ...base, type: 'SERVICE', sacCode: '123456' });
    expect(result.success).toBe(false);
  });
});

describe('product lifecycle', () => {
  it('cannot skip DRAFT straight past review into DISCONTINUED', () => {
    expect(canTransitionProduct('DRAFT', 'DISCONTINUED')).toBe(false);
    expect(canTransitionProduct('DRAFT', 'ACTIVE')).toBe(true);
  });

  it('lets a discontinued product be reactivated', () => {
    // Discontinued products remain orderable against existing stock.
    expect(canTransitionProduct('DISCONTINUED', 'ACTIVE')).toBe(true);
  });

  it('treats ARCHIVED as terminal', () => {
    expect(PRODUCT_TRANSITIONS.ARCHIVED).toEqual([]);
  });

  it('declares a transition list for every status, so none is unreachable', () => {
    for (const status of PRODUCT_STATUSES) {
      expect(PRODUCT_TRANSITIONS[status as ProductStatus]).toBeDefined();
    }
  });
});

describe('price list lifecycle', () => {
  it('never reopens a published list back to draft', () => {
    // Orders were negotiated against it; reopening would silently reprice them.
    expect(canTransitionPriceList('ACTIVE', 'DRAFT' as never)).toBe(false);
    expect(canTransitionPriceList('ARCHIVED', 'ACTIVE')).toBe(false);
  });

  it('allows draft → active and active → archived', () => {
    expect(canTransitionPriceList('DRAFT', 'ACTIVE')).toBe(true);
    expect(canTransitionPriceList('ACTIVE', 'ARCHIVED')).toBe(true);
  });
});

describe('price override', () => {
  it('requires a reason', () => {
    expect(priceOverrideSchema.safeParse({ unitPrice: '1000' }).success).toBe(false);
  });

  it('rejects a reason too short to explain anything', () => {
    const result = priceOverrideSchema.safeParse({ unitPrice: '1000', reason: 'ok' });
    expect(result.success).toBe(false);
  });

  it('accepts a substantive reason', () => {
    const result = priceOverrideSchema.safeParse({
      unitPrice: '1000',
      reason: 'Matched competitor on the NTPC Mouda tender',
    });
    expect(result.success).toBe(true);
  });
});

describe('discount rule scope and target', () => {
  const base = { code: 'R1', name: 'Rule', type: 'PERCENT' as const, value: '10', validFrom: '2026-04-01' };

  it('refuses a GLOBAL rule that names a target', () => {
    const result = createDiscountRuleSchema.safeParse({
      ...base,
      scope: 'GLOBAL',
      targetId: '019fcc4b-d02b-7923-87bf-c97194da9325',
    });
    expect(result.success).toBe(false);
  });

  it('refuses a scoped rule with no target', () => {
    expect(createDiscountRuleSchema.safeParse({ ...base, scope: 'PRODUCT' }).success).toBe(false);
  });

  it('refuses a percentage above 100 — that would pay the customer', () => {
    const result = createDiscountRuleSchema.safeParse({ ...base, scope: 'GLOBAL', value: '150' });
    expect(result.success).toBe(false);
  });

  it('refuses an end date before the start date', () => {
    const result = createDiscountRuleSchema.safeParse({
      ...base,
      scope: 'GLOBAL',
      validTo: '2026-01-01',
    });
    expect(result.success).toBe(false);
  });
});

describe('quote request', () => {
  const productId = '019fcc4b-d02b-7923-87bf-c97194da9325';

  it('requires at least one line', () => {
    expect(quoteRequestSchema.safeParse({ lines: [] }).success).toBe(false);
  });

  it('rejects a non-positive quantity', () => {
    const result = quoteRequestSchema.safeParse({ lines: [{ productId, quantity: '0' }] });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed place-of-supply state code', () => {
    const result = quoteRequestSchema.safeParse({
      lines: [{ productId, quantity: '1' }],
      placeOfSupplyStateCode: 'MH',
    });
    expect(result.success).toBe(false);
  });

  it('defaults the trace on, because an unexplained price is unauditable', () => {
    const result = quoteRequestSchema.parse({ lines: [{ productId, quantity: '1' }] });
    expect(result.includeTrace).toBe(true);
  });
});

describe('buildCategoryTree', () => {
  const node = (id: string, parentId: string | null, sortOrder = 0): CategoryTreeFields => ({
    id,
    parentId,
    name: id,
    sortOrder,
  });

  it('nests children under their parent', () => {
    const tree = buildCategoryTree([node('a', null), node('b', 'a'), node('c', 'b')]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children[0]?.id).toBe('b');
    expect(tree[0]?.children[0]?.children[0]?.id).toBe('c');
  });

  it('orders siblings by sortOrder, then by name', () => {
    const tree = buildCategoryTree([
      node('root', null),
      node('second', 'root', 20),
      node('first', 'root', 10),
    ]);
    expect(tree[0]?.children.map((c) => c.id)).toEqual(['first', 'second']);
  });

  it('surfaces an orphan as a root rather than dropping it', () => {
    // A node whose parent was filtered out of the result set must still appear,
    // or the rendered tree would disagree with the reported count.
    const tree = buildCategoryTree([node('orphan', 'missing-parent')]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.id).toBe('orphan');
  });

  it('handles an empty input', () => {
    expect(buildCategoryTree([])).toEqual([]);
  });
});
