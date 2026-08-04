import { Global, Module } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';
import { BUSINESS_TRANSPORT, MailService, OPS_TRANSPORT } from './mail.service';
import { LogTransport, SmtpTransport, type MailTransport } from './mail.transport';

/**
 * Wires two independent transports.
 *
 * A channel with no credentials falls back to the log transport rather than
 * failing at boot — a developer without SMTP access can still run the whole
 * application, and no real mail can escape a machine that was never configured
 * to send it.
 */
@Global()
@Module({
  providers: [
    {
      provide: BUSINESS_TRANSPORT,
      inject: [AppConfigService, PinoLogger],
      useFactory: (config: AppConfigService, logger: PinoLogger): MailTransport => {
        const mail = config.mailBusiness;
        if (mail.driver === 'log' || !mail.user || !mail.password) {
          logger.setContext('MailModule');
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
        if (mail.driver === 'log' || !mail.user || !mail.password) {
          logger.setContext('MailModule');
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
