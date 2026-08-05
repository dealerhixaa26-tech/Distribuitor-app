import { createSign } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';
import { SheetsPort, type SheetLocation } from './sheets.port';
import { TokenBucket } from './token-bucket';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Retryable transport failures. 429 is quota; 5xx is Google having a moment. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

interface SheetProperties {
  sheetId: number;
  title: string;
}

/**
 * The real Google Sheets v4 adapter.
 *
 * ⚠️ WRITTEN BUT NEVER EXECUTED. There is no Google Cloud service account for
 * this project (question E7), so every line below is compiled and reviewed but
 * has not made a single request. It is labelled that way in the Phase 10
 * completion record too, because "shipped" and "working" are different claims
 * and this codebase has been bitten by conflating them before — `docs/HANDOFF`
 * §4.17, where a library's documented API had not existed for a major version.
 *
 * Written against the REST API directly rather than pulling in `googleapis`:
 * that package is tens of megabytes for code that cannot run yet, and the
 * service-account flow is a signed JWT exchanged for a bearer token. When
 * credentials arrive there is nothing to install.
 *
 * What genuinely cannot be trusted until it has run:
 *   • the JWT assertion being accepted;
 *   • real 429/503 payload shapes, so the backoff below is written to
 *     documentation, not observation;
 *   • `values:append` semantics at the boundary between batches;
 *   • whether the delete-then-rename swap is atomic enough in practice.
 *
 * `LocalFileSheetsAdapter` proves everything upstream of this class.
 */
@Injectable()
export class GoogleSheetsAdapter extends SheetsPort {
  readonly provider = 'GOOGLE' as const;

  private requests = 0;
  private accessToken?: { value: string; expiresAtMs: number };
  private readonly bucket: TokenBucket;

  constructor(
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(GoogleSheetsAdapter.name);
    const perMinute = this.config.sheets.maxRequestsPerMinute;
    // Capacity below the sustained rate on purpose: a burst that empties the
    // bucket should be paced immediately rather than allowed to sprint into
    // the quota and then stall for a minute.
    this.bucket = new TokenBucket(Math.max(1, Math.floor(perMinute / 4)), perMinute);
  }

  // ── Authentication ──────────────────────────────────────────────────────

  /** Signs a service-account assertion and exchanges it for a bearer token. */
  private async token(): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.accessToken && this.accessToken.expiresAtMs > Date.now() + 60_000) {
      return this.accessToken.value;
    }

    const { serviceAccountEmail, privateKey } = this.config.sheets;
    if (!serviceAccountEmail || !privateKey) {
      throw new Error('Sheets credentials are not configured (SHEETS_SERVICE_ACCOUNT_EMAIL / SHEETS_PRIVATE_KEY)');
    }

    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: serviceAccountEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    };

    const b64 = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${b64(header)}.${b64(claims)}`;

    // The key arrives from the environment with literal \n, because a PEM
    // cannot survive a single-line .env value otherwise.
    const pem = privateKey.replace(/\\n/g, '\n');
    const signature = createSign('RSA-SHA256').update(unsigned).sign(pem, 'base64url');

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
    });

    if (!response.ok) {
      throw new Error(`Sheets token exchange failed: ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = {
      value: body.access_token,
      expiresAtMs: Date.now() + body.expires_in * 1000,
    };
    return this.accessToken.value;
  }

  // ── Request plumbing ────────────────────────────────────────────────────

  /** One quota-paced, backing-off request. */
  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const wait = this.bucket.waitMs();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.bucket.tryTake();

      const token = await this.token();
      this.requests++;

      const response = await fetch(`${SHEETS_API}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) return (await response.json()) as T;

      if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS) {
        // Google may name a delay; honour it, otherwise exponential.
        const retryAfter = Number(response.headers.get('retry-after'));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(60_000, 1_000 * 2 ** (attempt - 1));

        this.logger.warn(
          { status: response.status, attempt, delayMs, path },
          'Sheets API rate-limited or unavailable; backing off',
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      throw new Error(`Sheets API ${response.status} on ${path}: ${await response.text()}`);
    }

    throw new Error(`Sheets API exhausted ${MAX_ATTEMPTS} attempts on ${path}`);
  }

  private async sheets(spreadsheetId: string): Promise<SheetProperties[]> {
    const body = await this.call<{ sheets?: Array<{ properties: SheetProperties }> }>(
      `/${spreadsheetId}?fields=sheets.properties(sheetId,title)`,
    );
    return (body.sheets ?? []).map((s) => s.properties);
  }

  private async sheetId(spreadsheetId: string, title: string): Promise<number | undefined> {
    return (await this.sheets(spreadsheetId)).find((s) => s.title === title)?.sheetId;
  }

  // ── SheetsPort ──────────────────────────────────────────────────────────

  async ensureSheet(location: SheetLocation): Promise<void> {
    if ((await this.sheetId(location.spreadsheetId, location.title)) !== undefined) return;

    await this.call(`/${location.spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: location.title } } }],
      }),
    });
  }

  async appendRows(location: SheetLocation, rows: string[][]): Promise<void> {
    if (rows.length === 0) return;

    const range = encodeURIComponent(`${location.title}!A1`);
    await this.call(
      `/${location.spreadsheetId}/values/${range}:append` +
        `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values: rows }) },
    );
  }

  /**
   * Drop the live sheet, then rename staging into its place.
   *
   * Two operations in ONE batchUpdate so Google applies them together — a
   * separate delete followed by a separate rename would leave a window in which
   * the backup does not exist at all.
   */
  async swapSheet(staging: SheetLocation, target: SheetLocation): Promise<void> {
    const stagingId = await this.sheetId(staging.spreadsheetId, staging.title);
    if (stagingId === undefined) throw new Error(`Staging sheet ${staging.title} is missing`);
    const targetId = await this.sheetId(target.spreadsheetId, target.title);

    const requests: unknown[] = [];
    if (targetId !== undefined) requests.push({ deleteSheet: { sheetId: targetId } });
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: stagingId, title: target.title },
        fields: 'title',
      },
    });

    await this.call(`/${target.spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  }

  async readRows(location: SheetLocation): Promise<string[][]> {
    const range = encodeURIComponent(location.title);
    const body = await this.call<{ values?: string[][] }>(
      `/${location.spreadsheetId}/values/${range}`,
    );
    return body.values ?? [];
  }

  async deleteSheet(location: SheetLocation): Promise<void> {
    const id = await this.sheetId(location.spreadsheetId, location.title);
    if (id === undefined) return;

    await this.call(`/${location.spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ deleteSheet: { sheetId: id } }] }),
    });
  }

  /**
   * Authenticate, then read metadata. Nothing is written.
   *
   * The two failures are told apart on purpose, because their errors do not
   * distinguish themselves: a token exchange that fails is a credentials
   * problem, whereas a token that works followed by a 403 is a SHARING problem
   * — the spreadsheet was never shared with the service account. Google returns
   * 403 rather than 404 there, so without this split it reads like bad
   * credentials and sends you back to the key.
   */
  async probe(spreadsheetId: string): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.token();
    } catch (error) {
      return {
        ok: false,
        detail:
          `AUTH FAILED — the service account could not get a token. Check ` +
          `SHEETS_SERVICE_ACCOUNT_EMAIL and SHEETS_PRIVATE_KEY (quoted, literal \\n). ` +
          `${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      const titles = (await this.sheets(spreadsheetId)).map((s) => s.title);
      return {
        ok: true,
        detail: `authenticated and readable · ${titles.length} tab(s): ${titles.join(', ') || '(none yet)'}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('403')) {
        return {
          ok: false,
          detail:
            `NOT SHARED — the token works, so the credentials are fine, but the service ` +
            `account cannot open this spreadsheet. Share it with ` +
            `${this.config.sheets.serviceAccountEmail} as Editor. (Google returns 403, not ` +
            `404, which is why this reads like a credentials failure and is not one.)`,
        };
      }
      if (message.includes('404')) {
        return { ok: false, detail: `NOT FOUND — no spreadsheet with id ${spreadsheetId}` };
      }
      return { ok: false, detail: message };
    }
  }

  requestCount(): number {
    return this.requests;
  }
}
