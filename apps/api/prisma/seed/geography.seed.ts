import { GST_STATE_CODES, type GstStateCode } from '@hixaa/contracts';
import type { PrismaClient } from '@prisma/client';

/**
 * Geography reference data.
 *
 * The state list is derived from `GST_STATE_CODES` in @hixaa/contracts — the
 * same constant the GSTIN validator checks against. Maintaining a second list
 * here would let the database accept a state code the validator rejects.
 */

/** Postal abbreviation and UT flag, keyed by GST state code. */
const STATE_META: Record<GstStateCode, { code: string; unionTerritory?: boolean }> = {
  '01': { code: 'JK', unionTerritory: true },
  '02': { code: 'HP' },
  '03': { code: 'PB' },
  '04': { code: 'CH', unionTerritory: true },
  '05': { code: 'UK' },
  '06': { code: 'HR' },
  '07': { code: 'DL', unionTerritory: true },
  '08': { code: 'RJ' },
  '09': { code: 'UP' },
  '10': { code: 'BR' },
  '11': { code: 'SK' },
  '12': { code: 'AR' },
  '13': { code: 'NL' },
  '14': { code: 'MN' },
  '15': { code: 'MZ' },
  '16': { code: 'TR' },
  '17': { code: 'ML' },
  '18': { code: 'AS' },
  '19': { code: 'WB' },
  '20': { code: 'JH' },
  '21': { code: 'OD' },
  '22': { code: 'CG' },
  '23': { code: 'MP' },
  '24': { code: 'GJ' },
  '26': { code: 'DNHDD', unionTerritory: true },
  '27': { code: 'MH' },
  '29': { code: 'KA' },
  '30': { code: 'GA' },
  '31': { code: 'LD', unionTerritory: true },
  '32': { code: 'KL' },
  '33': { code: 'TN' },
  '34': { code: 'PY', unionTerritory: true },
  '35': { code: 'AN', unionTerritory: true },
  '36': { code: 'TG' },
  '37': { code: 'AP' },
  '38': { code: 'LA', unionTerritory: true },
  '97': { code: 'OT', unionTerritory: true },
  '99': { code: 'CJ', unionTerritory: true },
};

/**
 * Cities seeded only where Hixaa actually operates or sells today — Nagpur and
 * Pune (its two offices) plus the industrial centres its portfolio names.
 * A full Indian city list is tens of thousands of rows of noise; the address
 * form accepts free text, so this is autocomplete convenience, not a constraint.
 */
const SEED_CITIES: Array<{ gstStateCode: GstStateCode; name: string; pincode?: string }> = [
  { gstStateCode: '27', name: 'Nagpur', pincode: '440035' },
  { gstStateCode: '27', name: 'Pune', pincode: '411001' },
  { gstStateCode: '27', name: 'Mumbai', pincode: '400001' },
  { gstStateCode: '27', name: 'Chandrapur', pincode: '442401' },
  { gstStateCode: '22', name: 'Raipur', pincode: '492001' },
  { gstStateCode: '22', name: 'Korba', pincode: '495677' },
  { gstStateCode: '23', name: 'Singrauli', pincode: '486889' },
  { gstStateCode: '21', name: 'Angul', pincode: '759122' },
  { gstStateCode: '20', name: 'Dhanbad', pincode: '826001' },
  { gstStateCode: '09', name: 'Sonbhadra', pincode: '231216' },
  { gstStateCode: '36', name: 'Hyderabad', pincode: '500001' },
  { gstStateCode: '29', name: 'Bengaluru', pincode: '560001' },
  { gstStateCode: '24', name: 'Ahmedabad', pincode: '380001' },
  { gstStateCode: '07', name: 'New Delhi', pincode: '110001' },
];

export async function seedGeography(prisma: PrismaClient): Promise<void> {
  const india = await prisma.country.upsert({
    where: { code: 'IN' },
    create: { code: 'IN', name: 'India', dialCode: '+91', currency: 'INR' },
    update: { name: 'India', dialCode: '+91', currency: 'INR' },
    select: { id: true },
  });

  const stateIds = new Map<string, string>();

  for (const [gstStateCode, name] of Object.entries(GST_STATE_CODES)) {
    const meta = STATE_META[gstStateCode as GstStateCode];
    if (!meta) continue;

    const state = await prisma.state.upsert({
      where: { gstStateCode },
      create: {
        countryId: india.id,
        name,
        code: meta.code,
        gstStateCode,
        isUnionTerritory: meta.unionTerritory ?? false,
      },
      // Names and codes are statutory; keeping them reconciled means a
      // correction in the contracts constant propagates on the next deploy.
      update: { name, code: meta.code, isUnionTerritory: meta.unionTerritory ?? false },
      select: { id: true },
    });

    stateIds.set(gstStateCode, state.id);
  }

  for (const city of SEED_CITIES) {
    const stateId = stateIds.get(city.gstStateCode);
    if (!stateId) continue;

    await prisma.city.upsert({
      where: { stateId_name: { stateId, name: city.name } },
      create: { stateId, name: city.name, pincode: city.pincode ?? null },
      update: { pincode: city.pincode ?? null },
    });
  }

  console.log(
    `  ✓ 1 country, ${stateIds.size} states/UTs (GST codes), ${SEED_CITIES.length} cities`,
  );
}

/**
 * Industries Hixaa serves, promoted from a SystemSetting JSON blob to real rows
 * now that Customer (Phase 7) will reference them by foreign key.
 *
 * Source: hixaa.com — see docs/00-domain-and-scope.md §1.
 */
const INDUSTRIES = [
  {
    slug: 'thermal-power',
    name: 'Thermal Power Plants',
    description: 'Boiler maintenance, confined-space safety, and plant monitoring.',
  },
  { slug: 'coal', name: 'Coal', description: 'Handling, conveyance, and safety systems.' },
  {
    slug: 'mining',
    name: 'Mining',
    description: 'Underground and open-cast operations, including confined-space monitoring.',
  },
  { slug: 'cement', name: 'Cement', description: 'Process automation and monitoring.' },
  {
    slug: 'rail-simulation',
    name: 'Train Simulation',
    description: 'Simulator systems and training rigs.',
  },
] as const;

export async function seedIndustries(prisma: PrismaClient): Promise<void> {
  for (const [index, industry] of INDUSTRIES.entries()) {
    await prisma.industry.upsert({
      where: { slug: industry.slug },
      create: { ...industry, sortOrder: index },
      update: { name: industry.name, description: industry.description, sortOrder: index },
    });
  }
  console.log(`  ✓ ${INDUSTRIES.length} industries`);
}

/**
 * A starting territory tree, matching where Hixaa's portfolio says it sells.
 *
 * Seeded as a suggestion, not a fact — question E4 in
 * docs/12-recommendations.md asks how Hixaa actually divides India. Every node
 * is editable, and nothing downstream assumes this exact shape.
 */
const TERRITORY_TREE = [
  {
    code: 'WEST',
    name: 'West Zone',
    type: 'ZONE' as const,
    children: [
      { code: 'WEST-MH', name: 'Maharashtra', type: 'STATE' as const, gstStateCode: '27' },
      { code: 'WEST-GJ', name: 'Gujarat', type: 'STATE' as const, gstStateCode: '24' },
      { code: 'WEST-GA', name: 'Goa', type: 'STATE' as const, gstStateCode: '30' },
    ],
  },
  {
    code: 'CENTRAL',
    name: 'Central Zone',
    type: 'ZONE' as const,
    children: [
      { code: 'CENTRAL-MP', name: 'Madhya Pradesh', type: 'STATE' as const, gstStateCode: '23' },
      { code: 'CENTRAL-CG', name: 'Chhattisgarh', type: 'STATE' as const, gstStateCode: '22' },
    ],
  },
  {
    code: 'EAST',
    name: 'East Zone',
    type: 'ZONE' as const,
    children: [
      { code: 'EAST-OD', name: 'Odisha', type: 'STATE' as const, gstStateCode: '21' },
      { code: 'EAST-JH', name: 'Jharkhand', type: 'STATE' as const, gstStateCode: '20' },
      { code: 'EAST-WB', name: 'West Bengal', type: 'STATE' as const, gstStateCode: '19' },
    ],
  },
  {
    code: 'NORTH',
    name: 'North Zone',
    type: 'ZONE' as const,
    children: [
      { code: 'NORTH-UP', name: 'Uttar Pradesh', type: 'STATE' as const, gstStateCode: '09' },
      { code: 'NORTH-DL', name: 'Delhi NCR', type: 'STATE' as const, gstStateCode: '07' },
    ],
  },
  {
    code: 'SOUTH',
    name: 'South Zone',
    type: 'ZONE' as const,
    children: [
      { code: 'SOUTH-TG', name: 'Telangana', type: 'STATE' as const, gstStateCode: '36' },
      { code: 'SOUTH-KA', name: 'Karnataka', type: 'STATE' as const, gstStateCode: '29' },
      { code: 'SOUTH-TN', name: 'Tamil Nadu', type: 'STATE' as const, gstStateCode: '33' },
    ],
  },
];

export async function seedTerritories(prisma: PrismaClient): Promise<void> {
  let count = 0;

  for (const zone of TERRITORY_TREE) {
    const parent = await prisma.territory.upsert({
      where: { code: zone.code },
      create: { code: zone.code, name: zone.name, type: zone.type, path: '', depth: 0 },
      update: { name: zone.name },
      select: { id: true },
    });

    // The root's path references itself, so `path LIKE '%.<id>.%'` matches the
    // node as well as its descendants — one predicate for "this subtree".
    await prisma.territory.update({
      where: { id: parent.id },
      data: { path: `.${parent.id}.` },
    });
    count++;

    for (const child of zone.children) {
      const state = await prisma.state.findUnique({
        where: { gstStateCode: child.gstStateCode },
        select: { id: true },
      });

      const created = await prisma.territory.upsert({
        where: { code: child.code },
        create: {
          code: child.code,
          name: child.name,
          type: child.type,
          parentId: parent.id,
          stateId: state?.id ?? null,
          path: '',
          depth: 1,
        },
        update: { name: child.name, parentId: parent.id, stateId: state?.id ?? null, depth: 1 },
        select: { id: true },
      });

      await prisma.territory.update({
        where: { id: created.id },
        data: { path: `.${parent.id}.${created.id}.` },
      });
      count++;
    }
  }

  console.log(`  ✓ ${count} territories (${TERRITORY_TREE.length} zones)`);
}
