import type { PrismaClient } from '@prisma/client';

/**
 * Hixaa's company profile and portfolio — seeded as DATA, never hardcoded.
 *
 * This is how "do not hardcode portfolio data" is honoured: everything below
 * lands in `system_setting` rows, cached in Redis, and becomes editable from
 * the Admin Panel. No component, service, or template references Hixaa's name,
 * address, GSTIN, service lines, or industries directly.
 *
 * Source of truth: hixaa.com (products, services, about) and the company
 * LinkedIn profile — see docs/00-domain-and-scope.md §1.
 *
 * In Phases 3–4 the service lines become `Category` rows and the industries
 * become `Industry` rows; this file will populate those tables and keep the
 * settings copy for display. The shape is chosen now so that migration is a
 * move, not a rewrite.
 */

interface SettingSeed {
  category: string;
  key: string;
  value: unknown;
  description?: string;
  isSecret?: boolean;
}

/** Service lines, taken verbatim from the company's published services. */
export const HIXAA_SERVICE_LINES = [
  {
    slug: 'industrial-automation',
    name: 'Industrial Automation',
    description:
      'Use of control systems, such as computers or robots, and information technologies to ' +
      'handle industrial processes and machinery.',
    children: [
      'Automated Test Equipment',
      'Test Bench',
      'Wireless Controlling and Monitoring',
      'Machine Vision',
    ],
  },
  {
    slug: 'internet-of-things',
    name: 'Internet of Things',
    description:
      'Networks of physical objects embedded with sensors, software, and connectivity for ' +
      'industrial monitoring and control.',
    children: ['Industrial Internet of Things', 'Robotics', 'Long and Short Range Wireless'],
  },
  {
    slug: 'system-integration-labview',
    name: 'System Integration — LabVIEW',
    description:
      'NI LabVIEW device driver development and integration of physical and virtual components ' +
      'into a single working system.',
    children: [],
  },
  {
    slug: 'embedded-systems',
    name: 'Embedded Systems',
    description: 'Microprocessor-based hardware and firmware for purpose-built industrial devices.',
    children: [],
  },
  {
    slug: 'computer-vision',
    name: 'Computer Vision',
    description: 'Vision-based inspection, measurement, and automation using Python and OpenCV.',
    children: [],
  },
  {
    slug: 'pcb-designing',
    name: 'PCB Designing',
    description: 'Schematic capture, layout, and prototyping of custom printed circuit boards.',
    children: [],
  },
  {
    slug: 'data-acquisition-systems',
    name: 'Data Acquisition Systems',
    description: 'DAQ hardware and software for testing, measurement, and real-time analytics.',
    children: [],
  },
  {
    slug: 'product-engineering',
    name: 'Product Engineering',
    description:
      'Research, development, rapid prototyping, and additive manufacturing for OEM products.',
    children: ['OEM Solutions', 'Rapid Prototyping', '3D Printing'],
  },
  {
    slug: 'industrial-training',
    name: 'Industrial Training',
    description: 'LabVIEW and industrial automation training programmes.',
    children: [],
  },
] as const;

/** Industries Hixaa serves — becomes the `Industry` table in Phase 7. */
export const HIXAA_INDUSTRIES = [
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

/**
 * Raksha IoT — the flagship product, staged here until the catalog exists in
 * Phase 4, at which point it becomes a `Product` row with these specifications
 * and a BOM.
 */
export const RAKSHA_IOT = {
  sku: 'HTPL-RAKSHA-IOT',
  name: 'Raksha IoT',
  tagline: 'Your Safety Guardian in Confined Spaces',
  description:
    'IoT-based worker safety system for confined-space operations such as boiler maintenance ' +
    'in thermal power plants. Provides real-time worker monitoring, automated entry and exit ' +
    'logging, authorised-worker verification, and live hazard alerts.',
  type: 'KIT',
  features: [
    'Real-time worker monitoring and tracking',
    'Automated entry and exit logging via web dashboard',
    'Authorised worker verification for confined-space access',
    'Live alerts and proactive hazard prevention',
    'Irregularity notifications',
    'Bulk employee registration',
    'Smart report generation',
  ],
  characteristics: [
    'Completely autonomous operation',
    'Cross-platform solution',
    'Highly scalable architecture',
    'Multi-user management',
    'Technical support included',
  ],
  industries: ['thermal-power', 'coal', 'mining'],
} as const;

export async function seedPortfolio(prisma: PrismaClient): Promise<void> {
  const env = process.env;

  const settings: SettingSeed[] = [
    // ── Company identity ───────────────────────────────────────────────────
    {
      category: 'company',
      key: 'profile',
      description: 'Legal identity used on invoices and statutory documents.',
      value: {
        legalName: env.COMPANY_LEGAL_NAME ?? 'Hixaa Technologies Pvt. Ltd.',
        tradeName: env.COMPANY_TRADE_NAME ?? 'HIXAA',
        tagline: 'Excellence In Automation',
        secondaryTagline: 'Powerful Automation Solutions',
        website: 'https://hixaa.com',
        email: env.COMPANY_EMAIL ?? 'info@hixaa.com',
        phones: ['+91-9372429144', '+91-9860013298'],
        linkedin: 'https://in.linkedin.com/company/hixaa',
      },
    },
    {
      category: 'company',
      key: 'statutory',
      description: 'GSTIN drives the place-of-supply tax split — must be correct before invoicing.',
      value: {
        gstin: env.COMPANY_GSTIN ?? '',
        pan: env.COMPANY_PAN ?? '',
        stateCode: env.COMPANY_STATE_CODE ?? '27',
        cin: '',
        // Flags the placeholder so the invoicing module can refuse to issue a
        // legally defective document. See open question E1.
        verified: false,
      },
    },
    {
      category: 'company',
      key: 'registeredAddress',
      value: {
        line1: 'Yogeshwar, Plot #26B, Anmol Nagar',
        line2: 'Behind Santaji Nursing Home, Wathoda Square',
        city: 'Nagpur',
        state: 'Maharashtra',
        stateCode: '27',
        postalCode: '440035',
        country: 'India',
      },
    },
    {
      category: 'company',
      key: 'offices',
      value: [
        { name: 'Nagpur (Head Office)', city: 'Nagpur', state: 'Maharashtra', isPrimary: true },
        { name: 'Pune', city: 'Pune', state: 'Maharashtra', isPrimary: false },
      ],
    },

    // ── Branding ───────────────────────────────────────────────────────────
    {
      category: 'branding',
      key: 'theme',
      description: 'Placeholder brand values — replace with the official palette (question E10).',
      value: {
        primary: '#0057B8',
        primaryDark: '#3D8BFD',
        logoUrl: null,
        logoDarkUrl: null,
        faviconUrl: null,
      },
    },

    // ── Portfolio ──────────────────────────────────────────────────────────
    {
      category: 'portfolio',
      key: 'serviceLines',
      description: 'Becomes the Category tree in Phase 4.',
      value: HIXAA_SERVICE_LINES,
    },
    {
      category: 'portfolio',
      key: 'industries',
      description: 'Becomes the Industry table in Phase 7.',
      value: HIXAA_INDUSTRIES,
    },
    {
      category: 'portfolio',
      key: 'technologies',
      value: [
        'NI LabVIEW', 'Industry 4.0', 'IIoT', 'Machine Vision', 'Computer Vision',
        'Python', 'Data Acquisition', 'Wireless (long & short range)',
        'Rapid Prototyping', 'Additive Manufacturing',
      ],
    },
    {
      category: 'portfolio',
      key: 'flagshipProduct',
      description: 'Becomes a Product with specifications and a BOM in Phase 4.',
      value: RAKSHA_IOT,
    },

    // ── Financial configuration ────────────────────────────────────────────
    {
      category: 'finance',
      key: 'defaults',
      value: {
        currency: env.DEFAULT_CURRENCY ?? 'INR',
        financialYearStartMonth: Number(env.FINANCIAL_YEAR_START_MONTH ?? 4),
        invoicePrefix: env.INVOICE_NUMBER_PREFIX ?? 'HTPL/INV',
        orderPrefix: env.ORDER_NUMBER_PREFIX ?? 'SO',
        roundInvoiceToWholeRupee: true,
      },
    },
    {
      category: 'finance',
      key: 'paymentTerms',
      description: 'Default options until confirmed (question E9).',
      value: [
        { code: 'ADVANCE', name: 'Advance', days: 0 },
        { code: 'NET15', name: 'Net 15', days: 15 },
        { code: 'NET30', name: 'Net 30', days: 30 },
        { code: 'NET45', name: 'Net 45', days: 45 },
        { code: 'NET60', name: 'Net 60', days: 60 },
      ],
    },

    // ── Approval ceilings — configurable, not compiled in ───────────────────
    {
      category: 'approvals',
      key: 'ceilings',
      description: 'Overridden per role by Role.maxDiscountPercent / maxOrderValue.',
      value: {
        escalateWhenExceeded: true,
        preventSelfApproval: true,
        requireReasonOnOverride: true,
      },
    },
  ];

  for (const setting of settings) {
    await prisma.systemSetting.upsert({
      where: { category_key: { category: setting.category, key: setting.key } },
      create: {
        category: setting.category,
        key: setting.key,
        value: setting.value as never,
        description: setting.description ?? null,
        isSecret: setting.isSecret ?? false,
      },
      // Company data is operator-editable, so an existing row is NOT
      // overwritten — a deploy must never revert a change made in the Admin
      // Panel. Only the description is refreshed.
      update: { description: setting.description ?? null },
    });
  }

  console.log(`  ✓ ${settings.length} settings (company, branding, portfolio, finance)`);
  console.log(
    `  ✓ ${HIXAA_SERVICE_LINES.length} service lines, ${HIXAA_INDUSTRIES.length} industries`,
  );
}
