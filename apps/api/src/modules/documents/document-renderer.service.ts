import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Content, TDocumentDefinitions, StyleDictionary } from 'pdfmake/interfaces';
import { InternalError } from '../../common/errors/domain.error';
import { SettingsService } from '../settings/settings.service';

/**
 * The pdfmake 0.3 API, typed by hand.
 *
 * `@types/pdfmake` describes an older surface. Three facts about 0.3.x were
 * established by PROBING the package, not from its README (which documents the
 * 0.2 `new PdfPrinter(fonts)` form that no longer exists):
 *
 *   • `require('pdfmake')` returns a configured INSTANCE, not a class.
 *   • Fonts are registered with `addFonts()`, not passed to a constructor.
 *   • `createPdf(def).getBuffer()` is async and returns a Buffer directly.
 *
 * Getting this from the docs would have produced code that typechecked and
 * threw at the first render.
 */
interface PdfMakeInstance {
  addFonts(fonts: Record<string, Record<string, string>>): void;
  createPdf(definition: TDocumentDefinitions): { getBuffer(): Promise<Buffer> };
  setUrlAccessPolicy(callback: (url: string) => boolean): void;
  setLocalAccessPolicy(callback: (path: string) => boolean): void;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfmake = require('pdfmake') as PdfMakeInstance;

/**
 * Shared PDF rendering. See ADR-0013.
 *
 * ── Why pdfmake and not headless Chrome ────────────────────────────────────
 * Everything runs on ONE Hostinger VPS: API, worker, Postgres, Redis. Puppeteer
 * would add ~300 MB of Chromium to the image and 100–200 MB of RAM per render.
 * pdfmake is pure JavaScript, renders in milliseconds, and produces
 * deterministic output — which also makes a document definition testable
 * without rasterising anything.
 *
 * ── What lives here versus in a document builder ───────────────────────────
 * This owns page setup, fonts, styles, and the company header. A builder
 * (quotation, and Phase 8's tax invoice) supplies only its own content. That
 * split is the whole reason the renderer was built in Phase 7 rather than
 * twice.
 *
 * ── Company identity is DATA ───────────────────────────────────────────────
 * Legal name, GSTIN, address, and brand colour are read from settings, never
 * hardcoded. `portfolio.seed.ts` populates them and the Admin Panel edits them,
 * which is the same rule the rest of the system follows.
 */
@Injectable()
export class DocumentRendererService {
  constructor(
    private readonly settings: SettingsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DocumentRendererService.name);

    /*
     * Roboto ships with pdfmake as real TTF files, and its subset was verified
     * to contain U+20B9 (₹) before this was written — ADR-0013 §5 required
     * checking rather than trusting, because an invoice rendering `?` where the
     * rupee sign belongs is a defect a customer sees before we do.
     *
     * Resolved through `require.resolve` rather than a relative path: pnpm's
     * content-addressed store means `node_modules/pdfmake` is a symlink whose
     * real location is not predictable from here.
     */
    let fontDir: string;
    try {
      fontDir = path.join(path.dirname(require.resolve('pdfmake/package.json')), 'fonts', 'Roboto');
    } catch (error) {
      throw new InternalError('pdfmake fonts could not be located', { err: String(error) });
    }

    pdfmake.addFonts({
      Roboto: {
        normal: path.join(fontDir, 'Roboto-Regular.ttf'),
        bold: path.join(fontDir, 'Roboto-Medium.ttf'),
        italics: path.join(fontDir, 'Roboto-Italic.ttf'),
        bolditalics: path.join(fontDir, 'Roboto-MediumItalic.ttf'),
      },
    });

    /*
     * Lock down what a document definition may reach.
     *
     * pdfmake warns when these are unset, and the warning is worth heeding: a
     * definition can name an image by URL or by local path, and our definitions
     * are built from database content. Without a policy, a crafted product name
     * or address could make the renderer fetch an arbitrary URL (SSRF) or read
     * an arbitrary file off the VPS.
     *
     * Nothing we render loads external resources, so both are refused outright
     * except for the bundled font directory.
     */
    pdfmake.setUrlAccessPolicy(() => false);
    pdfmake.setLocalAccessPolicy((requested) => requested.startsWith(fontDir));
  }

  /** The company block every document carries, read from settings. */
  async companyProfile(): Promise<CompanyProfile> {
    const [profile, statutory, address, branding] = await Promise.all([
      this.settings.get<Record<string, unknown>>('company', 'profile'),
      this.settings.get<Record<string, unknown>>('company', 'statutory'),
      this.settings.get<Record<string, unknown>>('company', 'registeredAddress'),
      this.settings.get<Record<string, unknown>>('branding', 'theme'),
    ]);

    return {
      legalName: str(profile?.legalName) ?? 'Company',
      tradeName: str(profile?.tradeName),
      tagline: str(profile?.tagline),
      email: str(profile?.email),
      phones: Array.isArray(profile?.phones) ? (profile.phones as string[]) : [],
      website: str(profile?.website),
      gstin: str(statutory?.gstin),
      pan: str(statutory?.pan),
      cin: str(statutory?.cin),
      // Whether the statutory identity has been confirmed. Phase 8 refuses to
      // ISSUE an invoice while this is false; a quotation only warns.
      statutoryVerified: statutory?.verified === true,
      addressLines: [
        str(address?.line1),
        str(address?.line2),
        [str(address?.city), str(address?.state), str(address?.postalCode)]
          .filter(Boolean)
          .join(', '),
      ].filter((line): line is string => Boolean(line)),
      primaryColour: str(branding?.primary) ?? '#0057B8',
    };
  }

  /**
   * Renders a document definition to a PDF buffer.
   *
   * Buffered rather than streamed: these documents are a few pages, they are
   * emailed as attachments through the outbox, and a Buffer is what both that
   * and a download response want.
   */
  async render(definition: TDocumentDefinitions): Promise<Buffer> {
    const pdf = pdfmake.createPdf({
      ...definition,
      defaultStyle: { font: 'Roboto', fontSize: 9, ...definition.defaultStyle },
      styles: { ...BASE_STYLES, ...(definition.styles ?? {}) },
    });
    return pdf.getBuffer();
  }

  /** The letterhead: company identity on the left, document title on the right. */
  header(company: CompanyProfile, title: string, subtitle: string): Content {
    return {
      columns: [
        {
          width: '*',
          stack: [
            { text: company.legalName, style: 'companyName' },
            ...(company.tagline ? [{ text: company.tagline, style: 'tagline' }] : []),
            { text: company.addressLines.join('\n'), style: 'small', margin: [0, 4, 0, 0] },
            {
              text: [
                company.phones.length ? `T ${company.phones.join(' · ')}` : '',
                company.email ? `  ${company.email}` : '',
              ].join(''),
              style: 'small',
            },
            ...(company.gstin
              ? [{ text: `GSTIN ${company.gstin}`, style: 'small', bold: true }]
              : []),
          ],
        },
        {
          width: 'auto',
          stack: [
            { text: title, style: 'documentTitle', alignment: 'right' },
            { text: subtitle, style: 'small', alignment: 'right' },
          ],
        },
      ],
      margin: [0, 0, 0, 12],
    };
  }

  /** A labelled party block — "Bill To", "Ship To". */
  partyBlock(label: string, lines: readonly (string | null | undefined)[]): Content {
    const present = lines.filter((line): line is string => Boolean(line));
    return {
      stack: [
        { text: label, style: 'sectionLabel' },
        { text: present.length > 0 ? present.join('\n') : '—', style: 'small' },
      ],
    };
  }

  /** Page number, and the note that a quotation is not a tax invoice. */
  footer(note: string) {
    return (currentPage: number, pageCount: number): Content => ({
      columns: [
        { text: note, style: 'footer', width: '*' },
        {
          text: `Page ${currentPage} of ${pageCount}`,
          style: 'footer',
          alignment: 'right',
          width: 'auto',
        },
      ],
      margin: [36, 8, 36, 0],
    });
  }
}

/** Shared styles, so a quotation and an invoice look like the same company. */
const BASE_STYLES: StyleDictionary = {
  companyName: { fontSize: 15, bold: true },
  tagline: { fontSize: 8, italics: true, color: '#666666' },
  documentTitle: { fontSize: 17, bold: true },
  sectionLabel: {
    fontSize: 8,
    bold: true,
    color: '#666666',
    characterSpacing: 0.5,
    margin: [0, 0, 0, 2],
  },
  small: { fontSize: 8.5, lineHeight: 1.25 },
  tableHeader: { fontSize: 8, bold: true, color: '#FFFFFF', fillColor: '#333333' },
  cell: { fontSize: 8.5 },
  cellRight: { fontSize: 8.5, alignment: 'right' },
  totalLabel: { fontSize: 9, alignment: 'right' },
  totalValue: { fontSize: 9, alignment: 'right' },
  grandTotal: { fontSize: 11, bold: true, alignment: 'right' },
  words: { fontSize: 8.5, italics: true },
  footer: { fontSize: 7.5, color: '#888888' },
  warning: { fontSize: 8, color: '#B45309', bold: true },
};

export interface CompanyProfile {
  legalName: string;
  tradeName: string | null;
  tagline: string | null;
  email: string | null;
  phones: string[];
  website: string | null;
  gstin: string | null;
  pan: string | null;
  cin: string | null;
  statutoryVerified: boolean;
  addressLines: string[];
  primaryColour: string;
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
