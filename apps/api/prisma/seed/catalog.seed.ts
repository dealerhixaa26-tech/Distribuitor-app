import type { PrismaClient } from '@prisma/client';
import { HIXAA_SERVICE_LINES, RAKSHA_IOT } from './portfolio.seed';

/**
 * The catalog, seeded from the company portfolio.
 *
 * This is the promotion `portfolio.seed.ts` was written to anticipate — its own
 * header says "In Phases 3–4 the service lines become `Category` rows… this
 * file will populate those tables and keep the settings copy for display."
 * So the service lines are NOT re-listed here: they are imported from the one
 * place that owns them, and a change there flows into the category tree.
 *
 * Answer to open question E8: there is no Excel or Tally export to import. The
 * owner's instruction was to add the products from the company portfolio and
 * make the pricing situational. Everything below therefore comes from
 * hixaa.com as captured in docs/00-domain-and-scope.md, and every price is a
 * PLACEHOLDER that the owner is expected to correct — which is exactly what
 * price lists, volume slabs, discount rules, and the override path make cheap.
 *
 * Idempotent: safe on every deploy. Existing rows are never overwritten,
 * because a deploy must not revert a price someone set in the Admin Panel.
 */

// ── Units of measure, with the GST-mandated UQC codes ───────────────────────

const UNITS = [
  { code: 'NOS', name: 'Numbers', uqc: 'NOS', precision: 0 },
  { code: 'SET', name: 'Set', uqc: 'SET', precision: 0 },
  { code: 'PCS', name: 'Pieces', uqc: 'PCS', precision: 0 },
  { code: 'MTR', name: 'Metres', uqc: 'MTR', precision: 2 },
  { code: 'KGS', name: 'Kilograms', uqc: 'KGS', precision: 3 },
  { code: 'HRS', name: 'Hours', uqc: 'OTH', precision: 2 },
  { code: 'DAY', name: 'Man-days', uqc: 'OTH', precision: 2 },
  { code: 'LOT', name: 'Lot / Lump sum', uqc: 'OTH', precision: 0 },
  { code: 'LIC', name: 'Licence', uqc: 'OTH', precision: 0 },
  { code: 'AMC', name: 'Annual contract', uqc: 'OTH', precision: 0 },
] as const;

// ── GST rates in force ──────────────────────────────────────────────────────
//
// Date-effective by design (ADR-0008): a rate change is an INSERT, and
// historical invoices keep resolving their historical rate. `effectiveFrom` is
// set to the start of the current GST regime so no realistic invoice date
// predates a rate.

const GST_EPOCH = new Date('2017-07-01T00:00:00.000Z');

const TAX_RATES = [
  // Goods
  { hsnSacCode: '85176290', gstRate: 18, description: 'Communication / IoT gateways and transceivers' },
  { hsnSacCode: '85176990', gstRate: 18, description: 'Other communication apparatus' },
  { hsnSacCode: '90269000', gstRate: 18, description: 'Instruments for measuring flow, level, pressure — parts' },
  { hsnSacCode: '90318000', gstRate: 18, description: 'Measuring / checking instruments and machines' },
  { hsnSacCode: '90314900', gstRate: 18, description: 'Optical measuring and checking instruments (machine vision)' },
  { hsnSacCode: '85340000', gstRate: 18, description: 'Printed circuit boards' },
  { hsnSacCode: '84718000', gstRate: 18, description: 'Data-processing units — DAQ hardware' },
  { hsnSacCode: '85311090', gstRate: 18, description: 'Alarm and signalling apparatus' },
  { hsnSacCode: '85423900', gstRate: 18, description: 'Electronic integrated circuits' },
  // Services — SAC, always beginning 99
  { hsnSacCode: '998719', gstRate: 18, description: 'Maintenance and repair of industrial machinery (AMC, commissioning)' },
  { hsnSacCode: '998313', gstRate: 18, description: 'IT consulting and support services' },
  { hsnSacCode: '998314', gstRate: 18, description: 'IT design and development services (LabVIEW, firmware)' },
  { hsnSacCode: '998434', gstRate: 18, description: 'Software licensing — downloadable' },
  { hsnSacCode: '999293', gstRate: 18, description: 'Commercial training and coaching services' },
  { hsnSacCode: '998892', gstRate: 18, description: 'Design and prototyping services' },
] as const;

// ── Brands ──────────────────────────────────────────────────────────────────

const BRANDS = [
  {
    code: 'HIXAA',
    name: 'Hixaa',
    slug: 'hixaa',
    description: 'Hixaa Technologies’ own engineered products and systems.',
    website: 'https://hixaa.com',
  },
  {
    code: 'NI',
    name: 'National Instruments',
    slug: 'national-instruments',
    description: 'NI hardware and LabVIEW licences integrated into Hixaa systems.',
  },
  {
    code: 'GENERIC',
    name: 'Unbranded / Assembled',
    slug: 'unbranded',
    description: 'Components and assemblies without a distinct commercial brand.',
  },
] as const;

/**
 * Products, from the company portfolio.
 *
 * `RAKSHA_IOT` and the service lines come from `portfolio.seed.ts`; the
 * component breakdown below is what makes the flagship a KIT that explodes
 * rather than a single opaque SKU — the central domain requirement in
 * docs/00 §1.1.
 */
interface ProductSeed {
  sku: string;
  name: string;
  type: 'GOODS' | 'SERVICE' | 'KIT' | 'CONFIGURABLE';
  categorySlug: string;
  brandCode: string;
  uomCode: string;
  hsnCode?: string;
  sacCode?: string;
  shortDescription: string;
  description?: string;
  isSerialized?: boolean;
  warrantyMonths?: number;
  leadTimeDays?: number;
  tags: string[];
  /** Placeholder list price, GST-exclusive. The owner corrects these. */
  price: string;
  specifications?: Array<{ groupName: string; name: string; value: string; unit?: string }>;
}

const PRODUCTS: ProductSeed[] = [
  // ── Raksha IoT — the flagship, and its components ────────────────────────
  {
    sku: 'HTPL-RAKSHA-GW',
    name: 'Raksha IoT Gateway',
    type: 'GOODS',
    categorySlug: 'internet-of-things',
    brandCode: 'HIXAA',
    uomCode: 'NOS',
    hsnCode: '85176290',
    shortDescription: 'Confined-space entry gateway with long-range wireless backhaul.',
    description:
      'Mounts at the confined-space entry point. Tracks wearable tags in real time, logs entry ' +
      'and exit automatically, and relays hazard alerts to the Raksha server.',
    isSerialized: true,
    warrantyMonths: 12,
    leadTimeDays: 30,
    tags: ['raksha', 'iot', 'safety', 'confined-space'],
    price: '84000.0000',
    specifications: [
      { groupName: 'Electrical', name: 'Supply Voltage', value: '24', unit: 'V DC' },
      { groupName: 'Electrical', name: 'Power Consumption', value: '12', unit: 'W' },
      { groupName: 'Wireless', name: 'Range', value: '1000', unit: 'm' },
      { groupName: 'Wireless', name: 'Tag Capacity', value: '250', unit: 'tags' },
      { groupName: 'Environmental', name: 'Ingress Protection', value: 'IP65' },
      { groupName: 'Environmental', name: 'Operating Temperature', value: '-10 to 60', unit: '°C' },
    ],
  },
  {
    sku: 'HTPL-RAKSHA-TAG',
    name: 'Raksha Worker Tag',
    type: 'GOODS',
    categorySlug: 'internet-of-things',
    brandCode: 'HIXAA',
    uomCode: 'NOS',
    hsnCode: '85176990',
    shortDescription: 'Wearable worker tag for authorised-entry verification and tracking.',
    isSerialized: true,
    warrantyMonths: 12,
    leadTimeDays: 30,
    tags: ['raksha', 'iot', 'safety', 'wearable'],
    price: '4200.0000',
    specifications: [
      { groupName: 'Electrical', name: 'Battery Life', value: '18', unit: 'months' },
      { groupName: 'Physical', name: 'Weight', value: '45', unit: 'g' },
      { groupName: 'Environmental', name: 'Ingress Protection', value: 'IP67' },
      { groupName: 'Wireless', name: 'Range', value: '1000', unit: 'm' },
    ],
  },
  {
    sku: 'HTPL-RAKSHA-SRV',
    name: 'Raksha Server Licence',
    type: 'SERVICE',
    categorySlug: 'internet-of-things',
    brandCode: 'HIXAA',
    uomCode: 'LIC',
    sacCode: '998434',
    shortDescription: 'Server software licence — dashboard, reporting, and bulk registration.',
    warrantyMonths: 12,
    tags: ['raksha', 'software', 'licence'],
    price: '125000.0000',
    specifications: [
      { groupName: 'Software', name: 'Concurrent Users', value: '25' },
      { groupName: 'Software', name: 'Deployment', value: 'On-premise or cloud' },
      { groupName: 'Software', name: 'Reporting', value: 'Smart report generation' },
    ],
  },
  {
    sku: 'HTPL-RAKSHA-COMM',
    name: 'Raksha Commissioning & Site Training',
    type: 'SERVICE',
    categorySlug: 'internet-of-things',
    brandCode: 'HIXAA',
    uomCode: 'LOT',
    sacCode: '998719',
    shortDescription: 'On-site installation, calibration, commissioning, and operator training.',
    leadTimeDays: 15,
    tags: ['raksha', 'commissioning', 'service'],
    price: '95000.0000',
  },
  {
    // The KIT. This is the line a customer actually buys.
    sku: 'HTPL-RAKSHA-50',
    name: 'Raksha IoT — 50-Worker Deployment',
    type: 'KIT',
    categorySlug: 'internet-of-things',
    brandCode: 'HIXAA',
    uomCode: 'SET',
    hsnCode: '85176290',
    shortDescription: RAKSHA_IOT.tagline,
    description: RAKSHA_IOT.description,
    warrantyMonths: 12,
    leadTimeDays: 45,
    tags: ['raksha', 'iot', 'safety', 'kit', 'flagship'],
    price: '742000.0000',
    specifications: [
      { groupName: 'Coverage', name: 'Workers Supported', value: '50' },
      { groupName: 'Coverage', name: 'Entry Points', value: '2' },
      { groupName: 'Compliance', name: 'Application', value: 'Confined-space entry monitoring' },
      { groupName: 'Compliance', name: 'Target Industries', value: 'Thermal power, coal, mining' },
    ],
  },

  // ── Automated Test Equipment & test benches ─────────────────────────────
  {
    sku: 'HTPL-ATE-BENCH',
    name: 'Automated Test Equipment — Custom Bench',
    type: 'CONFIGURABLE',
    categorySlug: 'industrial-automation',
    brandCode: 'HIXAA',
    uomCode: 'NOS',
    hsnCode: '90318000',
    shortDescription: 'Custom ATE rig built to the DUT’s test specification.',
    description:
      'Designed around the Device Under Test: fixturing, instrumentation, switching, and a ' +
      'LabVIEW test sequence with pass/fail reporting.',
    warrantyMonths: 12,
    leadTimeDays: 90,
    tags: ['ate', 'test', 'labview', 'dut'],
    price: '1850000.0000',
    specifications: [
      { groupName: 'Software', name: 'Test Framework', value: 'NI LabVIEW' },
      { groupName: 'Capability', name: 'Test Channels', value: 'Configurable' },
      { groupName: 'Capability', name: 'Reporting', value: 'Automated pass/fail with traceability' },
    ],
  },
  {
    sku: 'HTPL-TESTBENCH',
    name: 'Test Bench — Rail / Simulation',
    type: 'CONFIGURABLE',
    categorySlug: 'industrial-automation',
    brandCode: 'HIXAA',
    uomCode: 'NOS',
    hsnCode: '90318000',
    shortDescription: 'Simulation and validation test bench for rail and traction systems.',
    warrantyMonths: 12,
    leadTimeDays: 120,
    tags: ['test-bench', 'rail', 'simulation'],
    price: '2400000.0000',
  },

  // ── Machine vision & computer vision ────────────────────────────────────
  {
    sku: 'HTPL-MV-CELL',
    name: 'Machine Vision Inspection Cell',
    type: 'CONFIGURABLE',
    categorySlug: 'industrial-automation',
    brandCode: 'HIXAA',
    uomCode: 'NOS',
    hsnCode: '90314900',
    shortDescription: 'Vision-based inspection cell for in-line measurement and defect detection.',
    warrantyMonths: 12,
    leadTimeDays: 75,
    tags: ['machine-vision', 'inspection', 'quality'],
    price: '1250000.0000',
    specifications: [
      { groupName: 'Optical', name: 'Camera Resolution', value: '5', unit: 'MP' },
      { groupName: 'Optical', name: 'Illumination', value: 'Programmable LED array' },
      { groupName: 'Software', name: 'Platform', value: 'Python / OpenCV' },
    ],
  },

  // ── Data acquisition ────────────────────────────────────────────────────
  {
    sku: 'HTPL-DAQ-16',
    name: 'Data Acquisition System — 16 Channel',
    type: 'GOODS',
    categorySlug: 'data-acquisition-systems',
    brandCode: 'HIXAA',
    uomCode: 'NOS',
    hsnCode: '84718000',
    shortDescription: '16-channel DAQ with real-time analytics and LabVIEW drivers.',
    isSerialized: true,
    warrantyMonths: 24,
    leadTimeDays: 45,
    tags: ['daq', 'measurement', 'labview'],
    price: '385000.0000',
    specifications: [
      { groupName: 'Electrical', name: 'Supply Voltage', value: '24', unit: 'V DC' },
      { groupName: 'Capability', name: 'Analog Input Channels', value: '16' },
      { groupName: 'Capability', name: 'Sample Rate', value: '100', unit: 'kS/s' },
      { groupName: 'Capability', name: 'Resolution', value: '16', unit: 'bit' },
    ],
  },

  // ── PCB & embedded ──────────────────────────────────────────────────────
  {
    sku: 'HTPL-PCB-DESIGN',
    name: 'PCB Design & Prototyping',
    type: 'SERVICE',
    categorySlug: 'pcb-designing',
    brandCode: 'HIXAA',
    uomCode: 'LOT',
    sacCode: '998892',
    shortDescription: 'Schematic capture, layout, fabrication liaison, and prototype bring-up.',
    leadTimeDays: 45,
    tags: ['pcb', 'design', 'prototyping'],
    price: '275000.0000',
  },
  {
    sku: 'HTPL-EMBEDDED-DEV',
    name: 'Embedded Firmware Development',
    type: 'SERVICE',
    categorySlug: 'embedded-systems',
    brandCode: 'HIXAA',
    uomCode: 'DAY',
    sacCode: '998314',
    shortDescription: 'Microprocessor firmware development, per man-day.',
    tags: ['embedded', 'firmware', 'development'],
    price: '14500.0000',
  },

  // ── LabVIEW / system integration ────────────────────────────────────────
  {
    sku: 'HTPL-LABVIEW-DRV',
    name: 'LabVIEW Device Driver Development',
    type: 'SERVICE',
    categorySlug: 'system-integration-labview',
    brandCode: 'NI',
    uomCode: 'DAY',
    sacCode: '998314',
    shortDescription: 'NI LabVIEW instrument driver development and system integration.',
    tags: ['labview', 'integration', 'driver'],
    price: '16500.0000',
  },

  // ── Training & support ──────────────────────────────────────────────────
  {
    sku: 'HTPL-TRAINING',
    name: 'Industrial Automation Training Programme',
    type: 'SERVICE',
    categorySlug: 'industrial-training',
    brandCode: 'HIXAA',
    uomCode: 'DAY',
    sacCode: '999293',
    shortDescription: 'LabVIEW and industrial automation training, per day, up to 15 participants.',
    tags: ['training', 'labview'],
    price: '32000.0000',
  },
  {
    sku: 'HTPL-AMC-STD',
    name: 'Annual Maintenance Contract — Standard',
    type: 'SERVICE',
    categorySlug: 'industrial-automation',
    brandCode: 'HIXAA',
    uomCode: 'AMC',
    sacCode: '998719',
    shortDescription: 'Preventive maintenance, remote support, and two site visits per year.',
    tags: ['amc', 'support', 'maintenance'],
    price: '145000.0000',
  },
];

/** The Raksha kit's bill of materials, per ONE 50-worker deployment. */
const RAKSHA_BOM = [
  { sku: 'HTPL-RAKSHA-GW', quantity: '2', isOptional: false },
  { sku: 'HTPL-RAKSHA-TAG', quantity: '50', isOptional: false },
  { sku: 'HTPL-RAKSHA-SRV', quantity: '1', isOptional: false },
  { sku: 'HTPL-RAKSHA-COMM', quantity: '1', isOptional: false },
  // Bought with most deployments but not every one — priced only when selected.
  { sku: 'HTPL-AMC-STD', quantity: '1', isOptional: true },
] as const;

export async function seedCatalog(prisma: PrismaClient): Promise<void> {
  // ── Units ───────────────────────────────────────────────────────────────
  for (const unit of UNITS) {
    await prisma.unitOfMeasure.upsert({
      where: { code: unit.code },
      create: unit,
      update: { name: unit.name, uqc: unit.uqc },
    });
  }
  console.log(`  ✓ ${UNITS.length} units of measure`);

  // ── Tax rates ───────────────────────────────────────────────────────────
  let ratesAdded = 0;
  for (const rate of TAX_RATES) {
    const existing = await prisma.taxRate.findFirst({
      where: { hsnSacCode: rate.hsnSacCode },
      select: { id: true },
    });
    // Never overwrite: a rate change must be a NEW row with its own effective
    // date (ADR-0008), not an edit that silently rewrites history.
    if (existing) continue;

    await prisma.taxRate.create({
      data: {
        hsnSacCode: rate.hsnSacCode,
        gstRate: rate.gstRate,
        cessRate: 0,
        effectiveFrom: GST_EPOCH,
        description: rate.description,
      },
    });
    ratesAdded++;
  }
  console.log(`  ✓ ${TAX_RATES.length} GST rates (${ratesAdded} new)`);

  // ── Brands ──────────────────────────────────────────────────────────────
  for (const brand of BRANDS) {
    await prisma.brand.upsert({
      where: { code: brand.code },
      create: brand,
      update: { name: brand.name },
    });
  }
  const brandsByCode = new Map(
    (await prisma.brand.findMany({ select: { id: true, code: true } })).map((b) => [b.code, b.id]),
  );
  console.log(`  ✓ ${BRANDS.length} brands`);

  // ── Categories, from the portfolio's service lines ──────────────────────
  //
  // Imported from portfolio.seed.ts rather than re-listed, so the category tree
  // and the published services can never drift apart.
  let categoryCount = 0;
  for (const [index, line] of HIXAA_SERVICE_LINES.entries()) {
    const parentId = await upsertCategory(prisma, {
      code: line.slug.toUpperCase().replace(/-/g, '_').slice(0, 40),
      name: line.name,
      slug: line.slug,
      description: line.description,
      parentId: null,
      sortOrder: index * 10,
    });
    categoryCount++;

    for (const [childIndex, childName] of line.children.entries()) {
      const childSlug = slugify(childName);
      await upsertCategory(prisma, {
        code: childSlug.toUpperCase().replace(/-/g, '_').slice(0, 40),
        name: childName,
        slug: childSlug,
        description: null,
        parentId,
        sortOrder: childIndex * 10,
      });
      categoryCount++;
    }
  }
  const categoriesBySlug = new Map(
    (await prisma.category.findMany({ select: { id: true, slug: true } })).map((c) => [
      c.slug,
      c.id,
    ]),
  );
  console.log(`  ✓ ${categoryCount} categories from the portfolio's service lines`);

  const unitsByCode = new Map(
    (await prisma.unitOfMeasure.findMany({ select: { id: true, code: true } })).map((u) => [
      u.code,
      u.id,
    ]),
  );

  // ── Products ────────────────────────────────────────────────────────────
  let productsAdded = 0;
  for (const seed of PRODUCTS) {
    const existing = await prisma.product.findUnique({
      where: { sku: seed.sku },
      select: { id: true },
    });
    if (existing) continue;

    const product = await prisma.product.create({
      data: {
        sku: seed.sku,
        name: seed.name,
        slug: slugify(seed.name),
        type: seed.type,
        // Seeded products are ACTIVE: they carry a tax code and a price, which
        // is exactly the bar `changeStatus` enforces for activation.
        status: 'ACTIVE',
        categoryId: categoriesBySlug.get(seed.categorySlug) ?? null,
        brandId: brandsByCode.get(seed.brandCode) ?? null,
        uomId: unitsByCode.get(seed.uomCode) ?? null,
        hsnCode: seed.hsnCode ?? null,
        sacCode: seed.sacCode ?? null,
        gstRate: 18,
        shortDescription: seed.shortDescription,
        description: seed.description ?? null,
        isSerialized: seed.isSerialized ?? false,
        warrantyMonths: seed.warrantyMonths ?? null,
        leadTimeDays: seed.leadTimeDays ?? null,
        tags: [...seed.tags],
        ...(seed.specifications?.length
          ? {
              specifications: {
                createMany: {
                  data: seed.specifications.map((spec, order) => ({
                    groupName: spec.groupName,
                    name: spec.name,
                    value: spec.value,
                    unit: spec.unit ?? null,
                    sortOrder: order,
                  })),
                },
              },
            }
          : {}),
      },
      select: { id: true },
    });
    productsAdded++;
    void product;
  }

  const productsBySku = new Map(
    (await prisma.product.findMany({ select: { id: true, sku: true } })).map((p) => [p.sku, p.id]),
  );
  console.log(`  ✓ ${PRODUCTS.length} products (${productsAdded} new)`);

  // ── The Raksha bill of materials ────────────────────────────────────────
  const kitId = productsBySku.get('HTPL-RAKSHA-50');
  let bomAdded = 0;
  if (kitId) {
    for (const [index, entry] of RAKSHA_BOM.entries()) {
      const componentId = productsBySku.get(entry.sku);
      if (!componentId) continue;

      const existing = await prisma.productBom.findFirst({
        where: { parentProductId: kitId, componentProductId: componentId },
        select: { id: true },
      });
      if (existing) continue;

      await prisma.productBom.create({
        data: {
          parentProductId: kitId,
          componentProductId: componentId,
          quantity: entry.quantity,
          isOptional: entry.isOptional,
          sortOrder: index * 10,
        },
      });
      bomAdded++;
    }
  }
  console.log(`  ✓ Raksha IoT bill of materials — ${RAKSHA_BOM.length} components (${bomAdded} new)`);

  // ── The default price list, with volume slabs ───────────────────────────
  //
  // "Make it such that its price can be changed according to situation": this
  // is the base. Slabs vary price by quantity, discount rules vary it by
  // partner and date, and POST /pricing/quote accepts a per-deal override.
  const priceList = await prisma.priceList.upsert({
    where: { code: 'STD-2026' },
    create: {
      code: 'STD-2026',
      name: 'Standard Price List 2026-27',
      status: 'ACTIVE',
      currency: 'INR',
      priceBasis: 'EXCLUSIVE',
      validFrom: new Date('2026-04-01T00:00:00.000Z'),
      isDefault: true,
      version: 1,
      description:
        'Baseline list prices, GST-exclusive. Placeholder figures pending the owner’s ' +
        'confirmation — clone and publish a new version rather than editing this one.',
      publishedAt: new Date('2026-04-01T00:00:00.000Z'),
    },
    update: {},
    select: { id: true, code: true },
  });

  let priceCount = 0;
  for (const seed of PRODUCTS) {
    const productId = productsBySku.get(seed.sku);
    if (!productId) continue;

    // Three slabs on the tag, one everywhere else. Tags are the only line item
    // ordered in volumes where a slab is meaningful; inventing slabs for a
    // ₹24-lakh test bench would be theatre.
    const slabs =
      seed.sku === 'HTPL-RAKSHA-TAG'
        ? [
            { minQty: '1', price: seed.price },
            { minQty: '50', price: '3990.0000' },
            { minQty: '200', price: '3750.0000' },
          ]
        : [{ minQty: '1', price: seed.price }];

    for (const slab of slabs) {
      const existing = await prisma.priceListItem.findFirst({
        where: {
          priceListId: priceList.id,
          productId,
          variantId: null,
          minQty: slab.minQty,
        },
        select: { id: true },
      });
      if (existing) continue;

      await prisma.priceListItem.create({
        data: {
          priceListId: priceList.id,
          productId,
          minQty: slab.minQty,
          price: slab.price,
          // A floor at 80% of list: below this an override is flagged for
          // approval no matter who the caller is.
          minPrice: (Number(slab.price) * 0.8).toFixed(4),
        },
      });
      priceCount++;
    }
  }
  console.log(`  ✓ Price list ${priceList.code} — ${priceCount} new price points (GST-exclusive)`);

  // ── A worked example of a situational discount ──────────────────────────
  const kitCategoryId = categoriesBySlug.get('internet-of-things');
  if (kitCategoryId) {
    await prisma.discountRule.upsert({
      where: { code: 'IOT-VOL-5' },
      create: {
        code: 'IOT-VOL-5',
        name: 'IoT volume — 5% over ₹10 lakh',
        scope: 'CATEGORY',
        targetId: kitCategoryId,
        type: 'PERCENT',
        value: 5,
        minAmount: 1_000_000,
        priority: 100,
        validFrom: new Date('2026-04-01T00:00:00.000Z'),
        isActive: true,
        description:
          'Illustrates category-scoped, threshold-gated pricing. Rules do not stack — see ADR-0007.',
      },
      update: {},
    });
    console.log('  ✓ 1 example discount rule (IOT-VOL-5)');
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Upserts a category and maintains its materialised path.
 *
 * The path contains the node's own id, so it can only be written after insert —
 * the same two-step the service uses.
 */
async function upsertCategory(
  prisma: PrismaClient,
  input: {
    code: string;
    name: string;
    slug: string;
    description: string | null;
    parentId: string | null;
    sortOrder: number;
  },
): Promise<string> {
  const existing = await prisma.category.findUnique({
    where: { slug: input.slug },
    select: { id: true },
  });
  if (existing) return existing.id;

  const parentPath = input.parentId
    ? ((
        await prisma.category.findUnique({
          where: { id: input.parentId },
          select: { path: true },
        })
      )?.path ?? null)
    : null;

  const created = await prisma.category.create({
    data: {
      code: input.code,
      name: input.name,
      slug: input.slug,
      description: input.description,
      parentId: input.parentId,
      sortOrder: input.sortOrder,
      path: '',
      depth: 0,
    },
    select: { id: true },
  });

  const path = parentPath ? `${parentPath}${created.id}.` : `.${created.id}.`;
  await prisma.category.update({
    where: { id: created.id },
    data: { path, depth: path.split('.').filter(Boolean).length - 1 },
  });

  return created.id;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}
