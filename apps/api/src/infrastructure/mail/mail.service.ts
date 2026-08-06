import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../database/prisma.service';
import {
  renderBusiness,
  renderOps,
  type BusinessTemplate,
  type BusinessTemplateData,
  type OpsTemplate,
  type OpsTemplateData,
} from './mail.templates';
import type { MailAttachment, MailTransport } from './mail.transport';

export const BUSINESS_TRANSPORT = Symbol('BUSINESS_TRANSPORT');
export const OPS_TRANSPORT = Symbol('OPS_TRANSPORT');

/**
 * The two email channels, behind one façade.
 *
 * Callers choose a channel by INTENT — `sendBusiness` or `sendOps` — and never
 * learn which SMTP host sits behind it. Because the template unions are
 * disjoint, the compiler refuses to send a deployment alert to a distributor or
 * a password reset to the ops mailbox.
 *
 * Both methods are called from the WORKER, fed by the outbox. Nothing here ever
 * runs on an API request path: an SMTP handshake that takes eight seconds must
 * not be eight seconds a user waits. See ADR-0005.
 */
@Injectable()
export class MailService {
  constructor(
    @Inject(BUSINESS_TRANSPORT) private readonly business: MailTransport,
    @Inject(OPS_TRANSPORT) private readonly ops: MailTransport,
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MailService.name);
  }

  /**
   * Customer-facing mail via Hostinger: welcome, verification, password reset,
   * order and dispatch notices, invoices, distributor communication, scheduled
   * reports.
   */
  async sendBusiness<T extends BusinessTemplate>(
    template: T,
    to: string,
    data: BusinessTemplateData[T],
    attachments?: MailAttachment[],
  ): Promise<void> {
    const rendered = renderBusiness(template, data);
    await this.dispatch({
      channel: 'BUSINESS',
      transport: this.business,
      to,
      template,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      replyTo: this.config.mailBusiness.replyTo,
      attachments,
    });
  }

  /**
   * Operator-facing mail via Gmail: deploys, migrations, backups, health,
   * queue depth, security events.
   *
   * The recipient is fixed by configuration rather than passed in — ops mail
   * has exactly one audience, and allowing a caller to choose would reopen the
   * channel-crossing risk this design removes.
   */
  async sendOps<T extends OpsTemplate>(template: T, data: OpsTemplateData[T]): Promise<void> {
    const recipient = this.config.mailOps.to;
    const rendered = renderOps(template, data);

    /*
     * ADR-0022. An alert that cannot be delivered is still RECORDED.
     *
     * This used to return early, before the EmailLog row was written, so an
     * unconfigured ops mailbox turned every alert into a log line and nothing
     * else — including a `critical` refresh-token-reuse alert, the signature of
     * token theft. The system detected it, revoked the token family, and then
     * failed to record that it had tried to tell anyone.
     *
     * The row is the evidence. Delivery is an attempt on top of it.
     */
    if (!recipient) {
      await this.prisma.db.emailLog.create({
        data: {
          channel: 'OPS',
          toAddress: '(unconfigured)',
          subject: rendered.subject,
          template,
          status: 'UNDELIVERABLE',
          error: 'MAIL_OPS_TO is not configured',
        },
      });
      this.logger.warn(
        { template, subject: rendered.subject },
        'MAIL_OPS_TO is not configured — alert recorded as UNDELIVERABLE, not sent',
      );
      return;
    }

    await this.dispatch({
      channel: 'OPS',
      transport: this.ops,
      to: recipient,
      template,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  }

  /** Startup diagnostics — reports which transports are actually reachable. */
  async verifyTransports(): Promise<{ business: boolean; ops: boolean }> {
    const [business, ops] = await Promise.all([this.business.verify(), this.ops.verify()]);
    if (!business) this.logger.warn('Business mail transport did not verify');
    if (!ops) this.logger.warn('Ops mail transport did not verify');
    return { business, ops };
  }

  private async dispatch(params: {
    channel: 'BUSINESS' | 'OPS';
    transport: MailTransport;
    to: string;
    template: string;
    subject: string;
    html: string;
    text: string;
    replyTo?: string;
    attachments?: MailAttachment[];
  }): Promise<void> {
    // Logged before sending, so a message that fails mid-flight still leaves a
    // trace. The row records the CHANNEL, making the separation auditable in
    // data as well as guaranteed in types.
    const log = await this.prisma.db.emailLog.create({
      data: {
        channel: params.channel,
        toAddress: params.to,
        subject: params.subject,
        template: params.template,
        status: 'QUEUED',
      },
      select: { id: true },
    });

    try {
      const { messageId } = await params.transport.send({
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        replyTo: params.replyTo,
        attachments: params.attachments,
      });

      await this.prisma.db.emailLog.update({
        where: { id: log.id },
        data: {
          status: 'SENT',
          providerMessageId: messageId,
          sentAt: new Date(),
          attempts: { increment: 1 },
        },
      });

      this.logger.info(
        { channel: params.channel, template: params.template, messageId },
        'Mail sent',
      );
    } catch (error) {
      await this.prisma.db.emailLog.update({
        where: { id: log.id },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message : String(error),
          attempts: { increment: 1 },
        },
      });

      this.logger.error(
        { err: error, channel: params.channel, template: params.template },
        'Mail send failed',
      );

      // Rethrown so BullMQ retries with backoff and, after exhaustion, the job
      // lands in the DLQ where it raises an ops alert. A failed customer email
      // must be visible, not swallowed.
      throw error;
    }
  }
}
