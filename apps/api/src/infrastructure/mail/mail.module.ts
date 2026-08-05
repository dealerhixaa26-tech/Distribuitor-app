import { Global, Module } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';
import { BUSINESS_TRANSPORT, MailService, OPS_TRANSPORT } from './mail.service';
import { LogTransport, SmtpTransport, type MailTransport } from './mail.transport';

/**
 * Wires two independent transports.
 *
 * ── Development never sends real mail, and that is keyed on NODE_ENV ────────
 *
 * The guard used to be "no credentials → log transport", which protected a
 * machine only for as long as it stayed unconfigured. The current `.env` points
 * the BUSINESS channel at `smtp.hostinger.com` as `noreply@hixaa.com`; the only
 * thing standing between a developer and real mail to real distributors was an
 * empty password field. Filling it in — to test the transport, say — would have
 * sent live invoices from a laptop.
 *
 * Outside production the log transport is now unconditional. `docs/07` §1 says
 * no real message may leave a developer's machine, and a rule that depends on
 * a field being left blank is not a rule.
 *
 * Missing credentials still fall back to the log transport, so a developer
 * without SMTP access can run everything. In production that path is
 * unreachable: `env.schema.ts` refuses to boot without both channels
 * configured (ADR-0022).
 */
@Global()
@Module({
  providers: [
    {
      provide: BUSINESS_TRANSPORT,
      inject: [AppConfigService, PinoLogger],
      useFactory: (config: AppConfigService, logger: PinoLogger): MailTransport => {
        const mail = config.mailBusiness;
        logger.setContext('MailModule');
        if (!config.isProduction) {
          logger.info('Business mail: not production — log transport, nothing will be sent');
          return new LogTransport('business', logger);
        }
        if (mail.driver === 'log' || !mail.user || !mail.password) {
          logger.warn('Business mail: no SMTP credentials, using log transport');
          return new LogTransport('business', logger);
        }
        return new SmtpTransport('business', {
          host: mail.host,
          port: mail.port,
          secure: mail.secure,
          user: mail.user,
          password: mail.password,
          fromName: mail.fromName,
          fromAddress: mail.fromAddress,
        });
      },
    },
    {
      provide: OPS_TRANSPORT,
      inject: [AppConfigService, PinoLogger],
      useFactory: (config: AppConfigService, logger: PinoLogger): MailTransport => {
        const mail = config.mailOps;
        logger.setContext('MailModule');
        if (!config.isProduction) {
          logger.info('Ops mail: not production — log transport, nothing will be sent');
          return new LogTransport('ops', logger);
        }
        if (mail.driver === 'log' || !mail.user || !mail.password) {
          logger.warn('Ops mail: no SMTP credentials, using log transport');
          return new LogTransport('ops', logger);
        }
        return new SmtpTransport('ops', {
          host: mail.host,
          port: mail.port,
          secure: mail.secure,
          user: mail.user,
          password: mail.password,
          fromAddress: mail.fromAddress,
        });
      },
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
