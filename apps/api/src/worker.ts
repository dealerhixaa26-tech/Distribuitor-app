import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppConfigService } from './config/app-config.service';
import { WorkerModule } from './worker.module';

/**
 * Background worker entry point.
 *
 * Runs the same image as the API with a different command, so the two can never
 * drift out of sync. It has no HTTP server: this process drains the outbox,
 * runs BullMQ processors, and executes scheduled jobs.
 *
 * Every third-party call in the system — SMTP, Google Sheets, PDF generation —
 * happens here and nowhere else. That is the mechanism behind "never slow down
 * API requests because of Google Sheets" (ADR-0005).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });

  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();

  const config = app.get(AppConfigService);

  logger.log(
    `Worker started [${config.app.env}] — concurrency ${config.queue.concurrency}, ` +
      `outbox poll ${config.outbox.pollIntervalMs}ms`,
    'Worker',
  );

  // Let BullMQ finish the job in flight rather than killing it mid-send.
  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}, shutting down worker gracefully`, 'Worker');
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
