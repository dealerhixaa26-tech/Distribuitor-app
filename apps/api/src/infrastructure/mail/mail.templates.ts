/**
 * Email templates, partitioned by channel at the TYPE level.
 *
 * `BusinessTemplateData` and `OpsTemplateData` are disjoint. `sendBusiness()`
 * accepts only the former and `sendOps()` only the latter, so sending a
 * deployment notification to a distributor — or a password reset to the ops
 * mailbox — is a TypeScript compile error, not a mistake discovered in
 * production. This is the strongest enforcement available for the requirement
 * that the two mailboxes never mix. See docs/07-integrations.md §1.
 *
 * Each key also declares its payload shape, so a template cannot be rendered
 * with the wrong variables.
 */

// ── BUSINESS: distributors, customers, employees (Hostinger) ────────────────

export interface BusinessTemplateData {
  welcome: { name: string; loginUrl: string; temporaryPassword?: string };
  'verify-email': { name: string; verifyUrl: string; expiresInMinutes: number };
  'password-reset': { name: string; resetUrl: string; expiresInMinutes: number };
  'password-changed': { name: string; changedAt: string; ipAddress?: string };
  'user-invited': { name: string; inviterName: string; acceptUrl: string; roleName: string };
  'account-locked': { name: string; unlockAt: string; attempts: number };

  // ── Documents that travel with a PDF ──────────────────────────────────────
  // Money is a preformatted STRING here, never a number (ADR-0004). The caller
  // has already resolved and formatted it; a template must not do arithmetic on
  // a figure a partner will treat as a commitment.
  'quotation-sent': {
    name: string;
    quotationNumber: string;
    validUntil: string;
    totalFormatted: string;
  };
  'invoice-issued': {
    name: string;
    invoiceNumber: string;
    invoiceDate: string;
    dueDate: string;
    totalFormatted: string;
  };
  'distributor-approved': { name: string; code: string; loginUrl: string };
  'report-ready': { name: string; reportName: string; generatedAt: string; rowCount: number };
}

export type BusinessTemplate = keyof BusinessTemplateData;

// ── OPS: the operator only (personal Gmail) ─────────────────────────────────

export interface OpsTemplateData {
  'deploy-result': {
    status: 'success' | 'failure';
    tag: string;
    durationSeconds: number;
    migrationsApplied: number;
    error?: string;
  };
  'backup-report': {
    status: 'success' | 'failure' | 'partial';
    target: string;
    sizeBytes?: number;
    durationSeconds: number;
    error?: string;
  };
  'health-alert': { check: string; consecutiveFailures: number; detail: string };
  'security-alert': {
    event: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    detail: string;
    userId?: string;
    ipAddress?: string;
  };
  'queue-alert': { queue: string; depth: number; deadLetterCount: number };
  'sheets-sync-failed': { entity: string; rowsProcessed: number; error: string };
  'error-spike': { count: number; windowMinutes: number; topError: string };
  /**
   * The daily slow-query digest. Aggregated by query SHAPE — one query at 2.2s
   * is noise, the same query 400 times is a missing index.
   */
  'slow-query-digest': {
    windowHours: number;
    thresholdMs: number;
    queries: Array<{ shape: string; count: number; avgMs: number; maxMs: number }>;
  };
  /**
   * The ledger and the derived balances disagree (ADR-0002). This is an
   * operator emergency and deliberately NOT a business template: it says
   * nothing a partner should see, and it needs to reach someone who can stop
   * stock moving on numbers that are wrong.
   */
  'reconciliation-drift': {
    quantityDrifts: number;
    reservationDrifts: number;
    checked: number;
    firstSku?: string;
  };
}

export type OpsTemplate = keyof OpsTemplateData;

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

// ── Rendering ───────────────────────────────────────────────────────────────

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

/**
 * Branded shell for business mail.
 *
 * Deliberately hand-written table-free HTML with inline styles rather than an
 * MJML build step: it is what MJML would compile to anyway, and it keeps a
 * compile stage out of the Phase 1 pipeline. If templates grow complex enough
 * to justify MJML, only this function changes.
 */
function businessLayout(heading: string, bodyHtml: string, footerNote?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a2230;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
    <div style="padding-bottom:20px;border-bottom:2px solid #0057B8;">
      <span style="font-size:20px;font-weight:700;letter-spacing:.5px;color:#0057B8;">HIXAA</span>
      <span style="font-size:12px;color:#66738a;margin-left:8px;">Excellence In Automation</span>
    </div>
    <div style="background:#ffffff;border:1px solid #e3e8ef;border-top:none;padding:28px 24px;">
      <h1 style="margin:0 0 16px;font-size:19px;line-height:1.35;font-weight:600;">${escapeHtml(heading)}</h1>
      ${bodyHtml}
    </div>
    <div style="padding-top:16px;font-size:12px;line-height:1.6;color:#8894a8;">
      ${footerNote ? `<p style="margin:0 0 8px;">${escapeHtml(footerNote)}</p>` : ''}
      <p style="margin:0;">Hixaa Technologies Pvt. Ltd. &middot; Nagpur, Maharashtra, India</p>
      <p style="margin:4px 0 0;">This is an automated message; replies are monitored during business hours.</p>
    </div>
  </div>
</body></html>`;
}

const button = (label: string, url: string): string =>
  `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0057B8;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:600;font-size:14px;">${escapeHtml(label)}</a></p>
   <p style="margin:0 0 8px;font-size:12px;color:#66738a;">If the button does not work, paste this into your browser:</p>
   <p style="margin:0;font-size:12px;word-break:break-all;color:#0057B8;">${escapeHtml(url)}</p>`;

const para = (text: string): string =>
  `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">${escapeHtml(text)}</p>`;

export function renderBusiness<T extends BusinessTemplate>(
  template: T,
  data: BusinessTemplateData[T],
): RenderedMail {
  switch (template) {
    case 'welcome': {
      const d = data as BusinessTemplateData['welcome'];
      const heading = `Welcome to Hixaa DMS, ${d.name}`;
      return {
        subject: 'Your Hixaa DMS account is ready',
        html: businessLayout(
          heading,
          para('Your account has been created. You can sign in using the link below.') +
            (d.temporaryPassword
              ? para(
                  `Temporary password: ${d.temporaryPassword} — you will be asked to change it on first sign-in.`,
                )
              : '') +
            button('Sign in', d.loginUrl),
        ),
        text: `${heading}\n\nSign in: ${d.loginUrl}${
          d.temporaryPassword
            ? `\nTemporary password: ${d.temporaryPassword} (you must change it on first sign-in)`
            : ''
        }`,
      };
    }

    case 'verify-email': {
      const d = data as BusinessTemplateData['verify-email'];
      return {
        subject: 'Verify your email address',
        html: businessLayout(
          'Confirm your email address',
          para(`Hello ${d.name}, please confirm this address to activate your account.`) +
            button('Verify email', d.verifyUrl) +
            para(`This link expires in ${d.expiresInMinutes} minutes.`),
        ),
        text: `Hello ${d.name},\n\nVerify your email: ${d.verifyUrl}\nExpires in ${d.expiresInMinutes} minutes.`,
      };
    }

    case 'password-reset': {
      const d = data as BusinessTemplateData['password-reset'];
      return {
        subject: 'Reset your Hixaa DMS password',
        html: businessLayout(
          'Reset your password',
          para(`Hello ${d.name}, use the link below to set a new password.`) +
            button('Reset password', d.resetUrl) +
            para(`This link expires in ${d.expiresInMinutes} minutes and can be used once.`),
          'If you did not request this, no action is needed — your password is unchanged.',
        ),
        text: `Hello ${d.name},\n\nReset your password: ${d.resetUrl}\nExpires in ${d.expiresInMinutes} minutes; single use.\n\nIf you did not request this, no action is needed.`,
      };
    }

    case 'password-changed': {
      const d = data as BusinessTemplateData['password-changed'];
      return {
        subject: 'Your password was changed',
        html: businessLayout(
          'Your password was changed',
          para(`Hello ${d.name}, your password was changed on ${d.changedAt}.`) +
            (d.ipAddress ? para(`Request origin: ${d.ipAddress}`) : '') +
            para('All other sessions have been signed out.'),
          'If this was not you, contact your administrator immediately.',
        ),
        text: `Hello ${d.name},\n\nYour password was changed on ${d.changedAt}.${
          d.ipAddress ? `\nOrigin: ${d.ipAddress}` : ''
        }\nAll other sessions have been signed out.\n\nIf this was not you, contact your administrator immediately.`,
      };
    }

    case 'user-invited': {
      const d = data as BusinessTemplateData['user-invited'];
      return {
        subject: `${d.inviterName} invited you to Hixaa DMS`,
        html: businessLayout(
          'You have been invited to Hixaa DMS',
          para(`${d.inviterName} has invited you to join as ${d.roleName}.`) +
            button('Accept invitation', d.acceptUrl),
        ),
        text: `${d.inviterName} invited you to Hixaa DMS as ${d.roleName}.\n\nAccept: ${d.acceptUrl}`,
      };
    }

    case 'account-locked': {
      const d = data as BusinessTemplateData['account-locked'];
      return {
        subject: 'Your account has been temporarily locked',
        html: businessLayout(
          'Account temporarily locked',
          para(
            `Hello ${d.name}, your account was locked after ${d.attempts} failed sign-in attempts.`,
          ) + para(`It will unlock automatically at ${d.unlockAt}.`),
          'If this was not you, contact your administrator.',
        ),
        text: `Hello ${d.name},\n\nYour account was locked after ${d.attempts} failed sign-in attempts.\nIt unlocks at ${d.unlockAt}.`,
      };
    }

    case 'quotation-sent': {
      const d = data as BusinessTemplateData['quotation-sent'];
      return {
        subject: `Quotation ${d.quotationNumber} from Hixaa Technologies`,
        html: businessLayout(
          `Quotation ${d.quotationNumber}`,
          para(`Dear ${d.name},`) +
            para('Please find our quotation attached as a PDF.') +
            para(`Total: ${d.totalFormatted}`) +
            para(`This quotation is valid until ${d.validUntil}.`),
          'Prices are exclusive of GST unless stated otherwise on the attached document.',
        ),
        text:
          `Dear ${d.name},\n\nPlease find quotation ${d.quotationNumber} attached.\n` +
          `Total: ${d.totalFormatted}\nValid until: ${d.validUntil}\n\n` +
          `Prices are exclusive of GST unless the attached document states otherwise.`,
      };
    }

    case 'invoice-issued': {
      const d = data as BusinessTemplateData['invoice-issued'];
      return {
        subject: `Tax invoice ${d.invoiceNumber} from Hixaa Technologies`,
        html: businessLayout(
          `Tax invoice ${d.invoiceNumber}`,
          para(`Dear ${d.name},`) +
            para(`Please find tax invoice ${d.invoiceNumber} attached, dated ${d.invoiceDate}.`) +
            para(`Amount due: ${d.totalFormatted}`) +
            para(`Payment is due by ${d.dueDate}.`),
          'This is a computer-generated tax invoice; the attached PDF is the document of record.',
        ),
        text:
          `Dear ${d.name},\n\nTax invoice ${d.invoiceNumber} dated ${d.invoiceDate} is attached.\n` +
          `Amount due: ${d.totalFormatted}\nDue by: ${d.dueDate}`,
      };
    }

    case 'distributor-approved': {
      const d = data as BusinessTemplateData['distributor-approved'];
      return {
        subject: 'Your Hixaa distributor account has been approved',
        html: businessLayout(
          'Your distributor account is approved',
          para(`Dear ${d.name},`) +
            para(
              `We are pleased to confirm your appointment as a Hixaa distributor. ` +
                `Your distributor code is ${d.code}.`,
            ) +
            button('Sign in', d.loginUrl),
        ),
        text: `Dear ${d.name},\n\nYour Hixaa distributor account (${d.code}) has been approved.\nSign in: ${d.loginUrl}`,
      };
    }

    case 'report-ready': {
      const d = data as BusinessTemplateData['report-ready'];
      return {
        subject: `${d.reportName} — ${d.generatedAt}`,
        html: businessLayout(
          d.reportName,
          para(`Dear ${d.name},`) +
            para(`Your scheduled report is attached, covering ${d.rowCount} row(s).`) +
            para(`Generated ${d.generatedAt}.`),
        ),
        text: `Dear ${d.name},\n\n${d.reportName} is attached (${d.rowCount} rows).\nGenerated ${d.generatedAt}.`,
      };
    }

    default: {
      // Exhaustiveness: adding a template without a case is a compile error.
      const exhaustive: never = template;
      throw new Error(`Unhandled business template: ${String(exhaustive)}`);
    }
  }
}

/**
 * Ops mail is deliberately plain and unbranded — it is machine output for one
 * reader, and monospace is easier to scan at 3 a.m. than a marketing layout.
 */
function opsLayout(title: string, rows: Array<[string, string]>, body?: string): string {
  const list = rows
    .map(
      ([key, value]) =>
        `<tr><td style="padding:3px 14px 3px 0;color:#666;white-space:nowrap;">${escapeHtml(key)}</td><td style="padding:3px 0;"><strong>${escapeHtml(value)}</strong></td></tr>`,
    )
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:#111;padding:16px;">
  <h2 style="margin:0 0 12px;font-size:15px;">${escapeHtml(title)}</h2>
  <table style="border-collapse:collapse;margin-bottom:12px;">${list}</table>
  ${body ? `<pre style="background:#f5f5f5;padding:10px;border-radius:4px;overflow-x:auto;white-space:pre-wrap;margin:0;">${escapeHtml(body)}</pre>` : ''}
</body></html>`;
}

const asText = (title: string, rows: Array<[string, string]>, body?: string): string =>
  `${title}\n${'─'.repeat(title.length)}\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}${
    body ? `\n\n${body}` : ''
  }`;

export function renderOps<T extends OpsTemplate>(
  template: T,
  data: OpsTemplateData[T],
): RenderedMail {
  switch (template) {
    case 'deploy-result': {
      const d = data as OpsTemplateData['deploy-result'];
      const ok = d.status === 'success';
      const title = `${ok ? '✅' : '❌'} Deploy ${d.status} — ${d.tag}`;
      const rows: Array<[string, string]> = [
        ['Tag', d.tag],
        ['Status', d.status],
        ['Duration', `${d.durationSeconds}s`],
        ['Migrations', String(d.migrationsApplied)],
      ];
      return {
        subject: `[Hixaa DMS] Deploy ${d.status}: ${d.tag}`,
        html: opsLayout(title, rows, d.error),
        text: asText(title, rows, d.error),
      };
    }

    case 'backup-report': {
      const d = data as OpsTemplateData['backup-report'];
      const icon = d.status === 'success' ? '✅' : d.status === 'partial' ? '⚠️' : '❌';
      const title = `${icon} Backup ${d.status} — ${d.target}`;
      const rows: Array<[string, string]> = [
        ['Target', d.target],
        ['Status', d.status],
        ['Duration', `${d.durationSeconds}s`],
        ['Size', d.sizeBytes ? `${(d.sizeBytes / 1_048_576).toFixed(1)} MB` : 'n/a'],
      ];
      return {
        subject: `[Hixaa DMS] Backup ${d.status}: ${d.target}`,
        html: opsLayout(title, rows, d.error),
        text: asText(title, rows, d.error),
      };
    }

    case 'health-alert': {
      const d = data as OpsTemplateData['health-alert'];
      const title = `🚨 Health check failing — ${d.check}`;
      const rows: Array<[string, string]> = [
        ['Check', d.check],
        ['Consecutive failures', String(d.consecutiveFailures)],
      ];
      return {
        subject: `[Hixaa DMS] Health check failing: ${d.check}`,
        html: opsLayout(title, rows, d.detail),
        text: asText(title, rows, d.detail),
      };
    }

    case 'security-alert': {
      const d = data as OpsTemplateData['security-alert'];
      const title = `🔐 Security event — ${d.event}`;
      const rows: Array<[string, string]> = [
        ['Event', d.event],
        ['Severity', d.severity.toUpperCase()],
        ['User', d.userId ?? 'n/a'],
        ['IP', d.ipAddress ?? 'n/a'],
      ];
      return {
        subject: `[Hixaa DMS] ${d.severity.toUpperCase()} security event: ${d.event}`,
        html: opsLayout(title, rows, d.detail),
        text: asText(title, rows, d.detail),
      };
    }

    case 'queue-alert': {
      const d = data as OpsTemplateData['queue-alert'];
      const title = `⚠️ Queue backlog — ${d.queue}`;
      const rows: Array<[string, string]> = [
        ['Queue', d.queue],
        ['Depth', String(d.depth)],
        ['Dead letters', String(d.deadLetterCount)],
      ];
      return {
        subject: `[Hixaa DMS] Queue backlog: ${d.queue}`,
        html: opsLayout(title, rows),
        text: asText(title, rows),
      };
    }

    case 'sheets-sync-failed': {
      const d = data as OpsTemplateData['sheets-sync-failed'];
      const title = `❌ Google Sheets backup failed — ${d.entity}`;
      const rows: Array<[string, string]> = [
        ['Entity', d.entity],
        ['Rows processed', String(d.rowsProcessed)],
      ];
      return {
        subject: `[Hixaa DMS] Sheets backup failed: ${d.entity}`,
        html: opsLayout(title, rows, d.error),
        text: asText(title, rows, d.error),
      };
    }

    case 'error-spike': {
      const d = data as OpsTemplateData['error-spike'];
      const title = `📈 Error spike — ${d.count} in ${d.windowMinutes}m`;
      const rows: Array<[string, string]> = [
        ['Count', String(d.count)],
        ['Window', `${d.windowMinutes} minutes`],
      ];
      return {
        subject: `[Hixaa DMS] Error spike: ${d.count} errors in ${d.windowMinutes}m`,
        html: opsLayout(title, rows, d.topError),
        text: asText(title, rows, d.topError),
      };
    }

    case 'slow-query-digest': {
      const d = data as OpsTemplateData['slow-query-digest'];
      const title = `\u{1F40C} Slow queries — ${d.queries.length} shape(s) over ${d.thresholdMs}ms`;
      const rows: Array<[string, string]> = [
        ['Window', `${d.windowHours}h`],
        ['Threshold', `${d.thresholdMs}ms`],
        ['Distinct shapes', String(d.queries.length)],
        ['Total slow calls', String(d.queries.reduce((n, q) => n + q.count, 0))],
      ];
      // Ordered by total time cost, so the first line is the one worth fixing.
      const body = d.queries
        .map((q) => `${String(q.count).padStart(5)}x  avg ${q.avgMs}ms  max ${q.maxMs}ms\n       ${q.shape}`)
        .join('\n\n');
      return {
        subject: `[Hixaa DMS] ${d.queries.length} slow query shape(s) in the last ${d.windowHours}h`,
        html: opsLayout(title, rows, body),
        text: asText(title, rows, body),
      };
    }

    case 'reconciliation-drift': {
      const d = data as OpsTemplateData['reconciliation-drift'];
      const title = `⚠️ Stock reconciliation drift — ${d.quantityDrifts} quantity, ${d.reservationDrifts} reservation`;
      const rows: Array<[string, string]> = [
        ['Quantity drifts', String(d.quantityDrifts)],
        ['Reservation drifts', String(d.reservationDrifts)],
        ['Balances checked', String(d.checked)],
        ['First SKU', d.firstSku || '(none reported)'],
      ];
      const body =
        'The ledger and the derived balances disagree. Balances are no longer trustworthy ' +
        'until this is explained. The job reports and does NOT heal — correcting silently ' +
        'would destroy the only evidence that a bug exists (ADR-0002).';
      return {
        subject: `[Hixaa DMS] Stock reconciliation drift: ${d.quantityDrifts + d.reservationDrifts} discrepancies`,
        html: opsLayout(title, rows, body),
        text: asText(title, rows, body),
      };
    }

    default: {
      const exhaustive: never = template;
      throw new Error(`Unhandled ops template: ${String(exhaustive)}`);
    }
  }
}
