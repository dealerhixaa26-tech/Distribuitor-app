import { createTransport, type Transporter } from 'nodemailer';
import type { PinoLogger } from 'nestjs-pino';

/**
 * Transport abstraction.
 *
 * `MailService` depends on this interface, never on nodemailer. Adding SES,
 * Resend, or Postmark later means writing one class — no business logic
 * changes, because a module only ever calls `sendBusiness('order-confirmed', …)`.
 * See docs/07-integrations.md §1.
 */
/**
 * A file travelling with a message.
 *
 * Buffer rather than a path or a stream: the PDF is rendered in memory by
 * `QuotationPdfService` / `InvoicePdfService` and never written to disk, so a
 * document a partner has not received yet leaves no artefact behind.
 */
export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface OutboundMail {
  to: string;
  cc?: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: MailAttachment[];
}

export interface MailTransport {
  readonly name: string;
  send(message: OutboundMail): Promise<{ messageId: string }>;
  verify(): Promise<boolean>;
}

export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromName?: string;
  fromAddress: string;
}

export class SmtpTransport implements MailTransport {
  readonly name: string;
  private readonly transporter: Transporter;

  constructor(
    name: string,
    private readonly options: SmtpTransportOptions,
  ) {
    this.name = name;
    this.transporter = createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth: options.user ? { user: options.user, pass: options.password } : undefined,
      // Pooling matters: the worker sends bursts (scheduled reports, dispatch
      // notifications) and a fresh TLS handshake per message is wasteful.
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: OutboundMail): Promise<{ messageId: string }> {
    const info = await this.transporter.sendMail({
      from: this.options.fromName
        ? `"${this.options.fromName}" <${this.options.fromAddress}>`
        : this.options.fromAddress,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      html: message.html,
      text: message.text,
      replyTo: message.replyTo,
      attachments: message.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });
    return { messageId: info.messageId };
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Writes mail to the log instead of sending it.
 *
 * The default in development and tests, so no real message can leave a
 * developer's machine — the single most common cause of a test email reaching
 * a real customer.
 */
export class LogTransport implements MailTransport {
  readonly name: string;

  constructor(
    name: string,
    private readonly logger: PinoLogger,
  ) {
    this.name = name;
  }

  async send(message: OutboundMail): Promise<{ messageId: string }> {
    const messageId = `log-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    // Attachments are named and sized rather than dumped: a developer needs to
    // see that the PDF was built and is not zero bytes, which is the failure
    // that actually happens.
    const attachments = message.attachments?.map((a) => `${a.filename} (${a.content.length}b)`);
    this.logger.info(
      { transport: this.name, to: message.to, subject: message.subject, messageId, attachments },
      `[mail:${this.name}] ${message.subject} → ${message.to}` +
        (attachments?.length ? ` [+${attachments.join(', ')}]` : ''),
    );
    return { messageId };
  }

  async verify(): Promise<boolean> {
    return true;
  }
}
