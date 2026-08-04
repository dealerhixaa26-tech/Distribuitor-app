import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { LoggerModule as PinoModule } from 'nestjs-pino';
import { AppConfigModule } from '../../config/config.module';
import { AppConfigService } from '../../config/app-config.service';

/**
 * Structured logging.
 *
 * Redaction is the part worth reading. Anything on this list is replaced before
 * a line is written, so a secret cannot reach disk via an accidentally logged
 * request body — the most common way credentials end up in a log aggregator.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.confirmPassword',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.otp',
  'req.body.secret',
  'req.body.bankAccountNumber',
  '*.password',
  '*.passwordHash',
  '*.refreshToken',
  '*.tokenHash',
  '*.secretEncrypted',
  '*.bankAccountNumber',
];

@Module({
  imports: [
    PinoModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.app.logLevel,
          // Human-readable in development; JSON in production so a log shipper
          // can parse it.
          transport: config.isProduction
            ? undefined
            : {
                target: 'pino-pretty',
                options: {
                  singleLine: true,
                  colorize: true,
                  translateTime: 'HH:MM:ss.l',
                  ignore: 'pid,hostname,req.headers,res.headers',
                },
              },
          redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },

          // Correlation id, propagated into every line of a request via
          // AsyncLocalStorage and echoed to the client in X-Request-Id.
          genReqId: (req, res) => {
            const existing = req.headers['x-request-id'];
            const id = (Array.isArray(existing) ? existing[0] : existing) || randomUUID();
            res.setHeader('X-Request-Id', id);
            return id;
          },

          customLogLevel: (_req, res, err) => {
            if (err || res.statusCode >= 500) return 'error';
            if (res.statusCode >= 400) return 'warn';
            return 'info';
          },

          // Health checks would otherwise dominate the log: Docker polls
          // /health/live every 30 seconds, forever.
          autoLogging: {
            ignore: (req) => (req.url ?? '').includes('/health/'),
          },

          serializers: {
            req: (req) => ({
              id: req.id,
              method: req.method,
              url: req.url,
              remoteAddress: req.remoteAddress,
            }),
            res: (res) => ({ statusCode: res.statusCode }),
          },
        },
      }),
    }),
  ],
})
export class LoggerModule {}
