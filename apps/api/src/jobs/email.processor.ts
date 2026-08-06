import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DOMAIN_EVENTS, QUEUE_NAMES, formatIndianDigits } from '@hixaa/contracts';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { RequestContextStore } from '../common/context/request-context';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { MailService } from '../infrastructure/mail/mail.service';
import { InvoicePdfService } from '../modules/finance/invoice-pdf.service';
import { QuotationPdfService } from '../modules/sales/quotation-pdf.service';

export interface OutboxJobData {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  actorUserId: string | null;
  requestId: string | null;
}

/**
 * Turns outbox events into email.
 *
 * Processors must be idempotent: the outbox guarantees at-least-once delivery,
 * so a job can legitimately run twice after a crash. Sending one duplicate
 * welcome email is an acceptable outcome; losing a password reset is not.
 *
 * Throwing here is correct — BullMQ retries with the exponential backoff
 * configured in QueueModule, and a job that exhausts its attempts lands in the
 * DLQ where MaintenanceProcessor raises an ops alert.
 */
@Processor(QUEUE_NAMES.EMAIL)
export class EmailProcessor extends WorkerHost {
  /**
   * Event types already reported as unhandled, so a misrouted event raises one
   * ops alert per process rather than one per occurrence. A wiring bug should
   * be noticed once, not turned into a mail flood that trains you to filter it.
   */
  private readonly reportedUnhandled = new Set<string>();

  constructor(
    private readonly mail: MailService,
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly quotationPdf: QuotationPdfService,
    private readonly invoicePdf: InvoicePdfService,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(EmailProcessor.name);
  }

  async process(job: Job<OutboxJobData>): Promise<void> {
    const { eventType, payload, aggregateId, requestId } = job.data;

    // Re-establish the correlation id from the originating request, so a log
    // line written here can be traced back to the click that caused it.
    await RequestContextStore.asSystem(
      `email:${eventType}`,
      requestId ?? job.id ?? 'unknown',
      async () => this.handle(eventType, payload, aggregateId),
    );
  }

  private async handle(
    eventType: string,
    payload: Record<string, unknown>,
    aggregateId: string,
  ): Promise<void> {
    const appUrl = this.config.app.url.replace(/\/$/, '');

    switch (eventType) {
      case DOMAIN_EVENTS.USER_CREATED:
      case DOMAIN_EVENTS.USER_INVITED: {
        const { email, name, token, roleName, inviterName } = payload as Record<string, string>;
        if (!email) return this.skip(eventType, 'no recipient');

        if (token) {
          await this.mail.sendBusiness('user-invited', email, {
            name: name ?? email,
            inviterName: inviterName ?? 'An administrator',
            roleName: roleName ?? 'a team member',
            acceptUrl: `${appUrl}/accept-invite?token=${token}`,
          });
        } else {
          await this.mail.sendBusiness('welcome', email, {
            name: name ?? email,
            loginUrl: `${appUrl}/login`,
          });
        }
        return;
      }

      case DOMAIN_EVENTS.USER_EMAIL_VERIFICATION_REQUESTED: {
        const { email, name, token, expiresInMinutes } = payload as Record<string, string>;
        if (!email || !token) return this.skip(eventType, 'missing email or token');

        await this.mail.sendBusiness('verify-email', email, {
          name: name ?? email,
          verifyUrl: `${appUrl}/verify-email?token=${token}`,
          expiresInMinutes: Number(expiresInMinutes ?? 60),
        });
        return;
      }

      case DOMAIN_EVENTS.USER_PASSWORD_RESET_REQUESTED: {
        const { email, name, token, expiresInMinutes } = payload as Record<string, string>;
        if (!email || !token) return this.skip(eventType, 'missing email or token');

        await this.mail.sendBusiness('password-reset', email, {
          name: name ?? email,
          resetUrl: `${appUrl}/reset-password?token=${token}`,
          expiresInMinutes: Number(expiresInMinutes ?? 30),
        });
        return;
      }

      case DOMAIN_EVENTS.USER_PASSWORD_CHANGED: {
        const { email, name, changedAt, ipAddress } = payload as Record<string, string>;
        if (!email) return this.skip(eventType, 'no recipient');

        await this.mail.sendBusiness('password-changed', email, {
          name: name ?? email,
          changedAt: changedAt ?? new Date().toISOString(),
          ipAddress,
        });
        return;
      }

      case DOMAIN_EVENTS.SECURITY_ACCOUNT_LOCKED: {
        const { email, name, unlockAt, attempts } = payload as Record<string, string>;
        if (email) {
          await this.mail.sendBusiness('account-locked', email, {
            name: name ?? email,
            unlockAt: unlockAt ?? '',
            attempts: Number(attempts ?? 0),
          });
        }
        // The operator is told as well — a lockout may be an attack in progress.
        await this.mail.sendOps('security-alert', {
          event: 'Account locked after repeated failed sign-ins',
          severity: 'medium',
          detail: `Account ${email ?? 'unknown'} locked until ${unlockAt ?? 'unknown'}.`,
        });
        return;
      }

      // ── Security events: ops channel only, never the business channel ─────
      case DOMAIN_EVENTS.SECURITY_TOKEN_REUSE_DETECTED: {
        const { userId, ipAddress, familyId } = payload as Record<string, string>;
        await this.mail.sendOps('security-alert', {
          event: 'Refresh token reuse detected',
          severity: 'critical',
          detail:
            `A rotated refresh token was replayed, indicating theft. The entire token ` +
            `family (${familyId ?? 'unknown'}) was revoked and all sessions terminated.`,
          userId,
          ipAddress,
        });
        return;
      }

      case DOMAIN_EVENTS.SECURITY_SENSITIVE_FIELD_CHANGED: {
        const { entityType, entityId, fields, userId } = payload as Record<string, string>;
        await this.mail.sendOps('security-alert', {
          event: 'Sensitive field changed',
          severity: 'high',
          detail: `${entityType ?? 'record'} ${entityId ?? ''} — fields: ${fields ?? 'unknown'}`,
          userId,
        });
        return;
      }

      case DOMAIN_EVENTS.SHEETS_SYNC_FAILED: {
        const { entity, rowsProcessed, error } = payload as Record<string, string>;
        await this.mail.sendOps('sheets-sync-failed', {
          entity: entity ?? 'unknown',
          rowsProcessed: Number(rowsProcessed ?? 0),
          error: error ?? 'unknown error',
        });
        return;
      }

      // ── Ledger and balances disagree: OPS, never business ────────────────
      case DOMAIN_EVENTS.STOCK_RECONCILIATION_DRIFT: {
        const { quantityDrifts, reservationDrifts, checked, firstSku } = payload as Record<
          string,
          string
        >;
        await this.mail.sendOps('reconciliation-drift', {
          quantityDrifts: Number(quantityDrifts ?? 0),
          reservationDrifts: Number(reservationDrifts ?? 0),
          checked: Number(checked ?? 0),
          firstSku: firstSku || undefined,
        });
        return;
      }

      // ── Documents that travel with a PDF ─────────────────────────────────
      case DOMAIN_EVENTS.QUOTATION_SENT:
        return this.sendQuotation(aggregateId, payload);

      case DOMAIN_EVENTS.INVOICE_ISSUED:
        return this.sendInvoice(aggregateId, payload);

      case DOMAIN_EVENTS.DISTRIBUTOR_APPROVED:
        return this.sendDistributorApproved(aggregateId, payload, appUrl);

      default:
        return this.reportUnhandled(eventType);
    }
  }

  /**
   * The quotation PDF, attached.
   *
   * The gap HANDOFF §8 recorded as "the handler is not written" — which was
   * only half the reason nothing arrived. The worker could not boot at all
   * between Phase 6 and Phase 9, so even a written handler would not have run.
   */
  private async sendQuotation(id: string, payload: Record<string, unknown>): Promise<void> {
    const { number, grandTotal, to } = payload as Record<string, string>;

    const quotation = await this.prisma.db.quotation.findUnique({
      where: { id },
      select: { validUntil: true, distributorId: true, customerId: true },
    });
    if (!quotation) return this.skip(DOMAIN_EVENTS.QUOTATION_SENT, `quotation ${id} not found`);

    // An explicit recipient list on the event wins: whoever sent the quotation
    // chose who should receive it, and that decision outranks the default.
    const explicit = (to ?? '').split(',').filter(Boolean);
    const recipients = explicit.length
      ? explicit
      : await this.counterpartyEmails(quotation.distributorId, quotation.customerId);

    if (recipients.length === 0) {
      return this.skip(DOMAIN_EVENTS.QUOTATION_SENT, `no recipient for quotation ${number}`);
    }

    const { buffer, filename } = await this.quotationPdf.render(id);

    for (const recipient of recipients) {
      await this.mail.sendBusiness(
        'quotation-sent',
        recipient,
        {
          name: recipient,
          quotationNumber: number ?? '',
          validUntil: quotation.validUntil?.toISOString().slice(0, 10) ?? 'further notice',
          totalFormatted: `₹${formatIndianDigits(grandTotal ?? '0')}`,
        },
        [{ filename, content: buffer, contentType: 'application/pdf' }],
      );
    }
  }

  /** The tax invoice PDF, attached. */
  private async sendInvoice(id: string, payload: Record<string, unknown>): Promise<void> {
    const { number, counterparty, grandTotal, dueDate } = payload as Record<string, string>;

    const invoice = await this.prisma.db.invoice.findUnique({
      where: { id },
      select: { invoiceDate: true, distributorId: true, customerId: true },
    });
    if (!invoice) return this.skip(DOMAIN_EVENTS.INVOICE_ISSUED, `invoice ${id} not found`);

    const recipients = await this.counterpartyEmails(invoice.distributorId, invoice.customerId);
    if (recipients.length === 0) {
      return this.skip(DOMAIN_EVENTS.INVOICE_ISSUED, `no recipient for invoice ${number}`);
    }

    const { buffer, filename } = await this.invoicePdf.render(id);

    for (const recipient of recipients) {
      await this.mail.sendBusiness(
        'invoice-issued',
        recipient,
        {
          name: counterparty ?? recipient,
          invoiceNumber: number ?? '',
          invoiceDate: invoice.invoiceDate?.toISOString().slice(0, 10) ?? '',
          dueDate: dueDate || 'on receipt',
          totalFormatted: `₹${formatIndianDigits(grandTotal ?? '0')}`,
        },
        [{ filename, content: buffer, contentType: 'application/pdf' }],
      );
    }
  }

  private async sendDistributorApproved(
    id: string,
    payload: Record<string, unknown>,
    appUrl: string,
  ): Promise<void> {
    const { code, legalName } = payload as Record<string, string>;
    const recipients = await this.counterpartyEmails(id, null);

    if (recipients.length === 0) {
      return this.skip(DOMAIN_EVENTS.DISTRIBUTOR_APPROVED, `no contact email for ${code}`);
    }

    for (const recipient of recipients) {
      await this.mail.sendBusiness('distributor-approved', recipient, {
        name: legalName ?? recipient,
        code: code ?? '',
        loginUrl: `${appUrl}/login`,
      });
    }
  }

  /**
   * Where a document should go.
   *
   * Neither `distributor` nor `customer` carries a top-level email — both hold
   * their addresses on a contact table — so the primary contact is the answer,
   * falling back to any contact with an address rather than sending nothing.
   */
  private async counterpartyEmails(
    distributorId: string | null,
    customerId: string | null,
  ): Promise<string[]> {
    const contacts = distributorId
      ? await this.prisma.db.distributorContact.findMany({
          where: { distributorId, email: { not: null } },
          select: { email: true, isPrimary: true },
        })
      : customerId
        ? await this.prisma.db.customerContact.findMany({
            where: { customerId, email: { not: null } },
            select: { email: true, isPrimary: true },
          })
        : [];

    const primary = contacts.filter((c) => c.isPrimary).map((c) => c.email);
    const chosen = primary.length > 0 ? primary : contacts.map((c) => c.email);
    return chosen.filter((email): email is string => Boolean(email));
  }

  /**
   * An event was routed to this queue and there is no handler for it.
   *
   * This used to be a debug line, which is how SEVEN events came to be routed
   * here and silently dropped — including `invoice.issued` and `quotation.sent`.
   * "This was addressed to me and I do not know what it is" is a wiring defect,
   * so it is reported as one, once per process per event type.
   */
  private async reportUnhandled(eventType: string): Promise<void> {
    if (this.reportedUnhandled.has(eventType)) return;
    this.reportedUnhandled.add(eventType);

    this.logger.warn({ eventType }, 'Event routed to the email queue with NO HANDLER');
    await this.mail.sendOps('security-alert', {
      event: 'Event routed to the email queue with no handler',
      severity: 'low',
      detail:
        `EVENT_QUEUE_ROUTING sends '${eventType}' to the email queue, but EmailProcessor ` +
        `has no case for it, so the event is being discarded. Either add a handler or ` +
        `route it to null.`,
    });
  }

  private skip(eventType: string, reason: string): void {
    // Deliberately not thrown: a malformed payload will fail identically on
    // every retry, so retrying wastes five attempts and buries a real failure
    // in the DLQ. It is logged as a warning instead.
    this.logger.warn({ eventType, reason }, 'Skipping email job');
  }
}
