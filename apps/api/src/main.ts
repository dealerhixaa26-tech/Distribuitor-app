import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Pino replaces Nest's logger entirely, so startup lines are structured
    // and correlated like everything else.
    bufferLogs: true,
    // We terminate TLS at Nginx; trusting its X-Forwarded-For is what makes
    // rate limiting and audit logs record the real client IP rather than the
    // proxy's.
    rawBody: false,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = app.get(AppConfigService);
  const { port, prefix, corsOrigins, name, env } = config.app;

  app.set('trust proxy', 1);
  app.setGlobalPrefix(prefix, {
    // Health checks must be reachable at a stable path for Docker and uptime
    // monitors, independent of the API version prefix.
    exclude: ['health/live', 'health/ready'],
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      hsts: config.isProduction
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.use(compression());
  app.use(cookieParser(config.auth.csrfSecret));

  // Exact origins only, never a wildcard — credentials are sent with requests.
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Idempotency-Replayed', 'Retry-After'],
    maxAge: 86_400,
  });

  // Drains in-flight requests on SIGTERM instead of dropping them, so a deploy
  // does not fail whatever was mid-flight.
  app.enableShutdownHooks();

  if (config.features.swagger && !config.isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle(`${name} API`)
        .setDescription(
          'Distributor Management System for Hixaa Technologies Pvt. Ltd.\n\n' +
            'Schemas are generated from the shared Zod contracts in @hixaa/contracts, ' +
            'so this specification cannot drift from the implementation (ADR-0001).\n\n' +
            'Monetary amounts are strings, never JSON numbers (ADR-0004).',
        )
        .setVersion('1.0')
        .addBearerAuth()
        .addCookieAuth(config.auth.cookieName)
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.listen(port, '0.0.0.0');

  logger.log(
    `${name} API listening on port ${port} [${env}] — prefix /${prefix}` +
      (config.features.swagger && !config.isProduction ? ' — docs at /api/docs' : ''),
    'Bootstrap',
  );
}

bootstrap().catch((error) => {
  // The config validator throws a formatted report; printing it raw keeps it
  // readable instead of burying it in a stack trace.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
