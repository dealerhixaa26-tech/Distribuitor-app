import type { PrismaClient } from '@prisma/client';

/**
 * Inventory seed.
 *
 * Answers to the questions asked before Phase 6 was built:
 *
 *   **E3 — how many warehouses, and where?** ONE, at the Nagpur head office.
 *   Transfers, transit stock, and multi-warehouse balances are all built
 *   because distributor warehouses need them and Phase 7 will create them —
 *   but seeding company warehouses that do not exist would be fiction, and the
 *   first person to open the screen would have to work out which were real.
 *
 *   **Opening stock?** None. The ledger starts EMPTY and stock arrives through
 *   real goods receipts, so every unit's provenance is recorded from day one.
 *   `POST /inventory/opening-balances` exists for the day figures are loaded
 *   from a stock take, and refuses once a product has movement history.
 *
 * Reorder levels ARE seeded for the Raksha components, because a low-stock
 * alert with no configured level never fires, and an alerting system that has
 * never fired is indistinguishable from a broken one.
 *
 * Idempotent: existing rows are never overwritten, so a deploy cannot revert a
 * level someone tuned in the Admin Panel.
 */

/** Per-product reorder policy at the Nagpur store. Quantities are units. */
const REORDER_POLICY = [
  // Long-lead IoT hardware: hold enough to cover a deployment while the next
  // batch is built. Lead time is 30 days on both.
  { sku: 'HTPL-RAKSHA-GW', reorderLevel: '4', reorderQuantity: '10' },
  { sku: 'HTPL-RAKSHA-TAG', reorderLevel: '100', reorderQuantity: '250' },
  // DAQ units are 45-day lead and rarely stocked deep.
  { sku: 'HTPL-DAQ-16', reorderLevel: '2', reorderQuantity: '5' },
] as const;

export async function seedInventory(prisma: PrismaClient): Promise<void> {
  // ── The one warehouse (E3) ──────────────────────────────────────────────
  const nagpurState = await prisma.state.findFirst({
    where: { gstStateCode: '27' },
    select: { id: true },
  });

  const nagpurTerritory = await prisma.territory.findFirst({
    where: { name: 'Maharashtra' },
    select: { id: true },
  });

  const existing = await prisma.warehouse.findUnique({
    where: { code: 'WH-NGP' },
    select: { id: true },
  });

  if (existing) {
    console.log('  – Warehouse WH-NGP already exists');
  } else {
    // The registered address from the company profile — the goods physically
    // sit at the head office.
    const address = nagpurState
      ? await prisma.address.create({
          data: {
            label: 'Nagpur Store',
            line1: 'Yogeshwar, Plot #26B, Anmol Nagar',
            line2: 'Behind Santaji Nursing Home, Wathoda Square',
            cityName: 'Nagpur',
            stateId: nagpurState.id,
            postalCode: '440035',
            countryCode: 'IN',
          },
          select: { id: true },
        })
      : null;

    await prisma.warehouse.create({
      data: {
        code: 'WH-NGP',
        name: 'Nagpur Main Store',
        type: 'COMPANY',
        addressId: address?.id ?? null,
        territoryId: nagpurTerritory?.id ?? null,
        isDefault: true,
        isActive: true,
      },
    });
    console.log('  ✓ 1 warehouse — WH-NGP, Nagpur Main Store (default)');
  }

  const warehouse = await prisma.warehouse.findUnique({
    where: { code: 'WH-NGP' },
    select: { id: true },
  });
  if (!warehouse) return;

  // ── Reorder policy ──────────────────────────────────────────────────────
  let policiesAdded = 0;
  for (const policy of REORDER_POLICY) {
    const product = await prisma.product.findUnique({
      where: { sku: policy.sku },
      select: { id: true },
    });
    if (!product) continue;

    const existingSetting = await prisma.inventorySetting.findUnique({
      where: {
        productId_warehouseId: { productId: product.id, warehouseId: warehouse.id },
      },
      select: { id: true },
    });
    if (existingSetting) continue;

    await prisma.inventorySetting.create({
      data: {
        productId: product.id,
        warehouseId: warehouse.id,
        reorderLevel: policy.reorderLevel,
        reorderQuantity: policy.reorderQuantity,
        alertEnabled: true,
      },
    });
    policiesAdded++;
  }

  console.log(
    `  ✓ ${REORDER_POLICY.length} reorder policies (${policiesAdded} new) — the ledger starts EMPTY by design`,
  );
}
