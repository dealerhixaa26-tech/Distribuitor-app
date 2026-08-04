import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DOMAIN_EVENTS, QUEUE_NAMES } from '@hixaa/contracts';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { RequestContextStore } from '../common/context/request-context';
import { AppConfigService } from '../config/app-config.service';
import { MailService } from '../infrastructure/mail/mail.service';

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
  constructor(
    private readonly mail: MailService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(EmailProcessor.name);
  }

  async process(job: Job<OutboxJobData>): Promise<void> {
    const { eventType, payload, requestId } = job.data;

    // Re-establish the correlation id from the originating request, so a log
    // line written here can be traced back to the click that caused it.
    await RequestContextStore.asSystem(
      `email:${eventType}`,
      requestId ?? job.id ?? 'unknown',
      async () => this.handle(eventType, payload),
    );
  }

  private async handle(eventType: string, payload: Record<string, unknown>): Promise<void> {
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

      default:
        this.logger.debug({ eventType }, 'No email handler for event; nothing to do');
    }
  }

  private skip(eventType: string, reason: string): void {
    // Deliberately not thrown: a malformed payload will fail identically on
    // every retry, so retrying wastes five attempts and buries a real failure
    // in the DLQ. It is logged as a warning instead.
    this.logger.warn({ eventType, reason }, 'Skipping email job');
  }
}
