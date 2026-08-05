import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '@hixaa/contracts';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';
import { StorageService } from '../../infrastructure/storage/storage.service';
import { GoogleSheetsAdapter } from '../../infrastructure/sheets/google-sheets.adapter';
import { LocalFileSheetsAdapter } from '../../infrastructure/sheets/local-file-sheets.adapter';
import { SheetsPort } from '../../infrastructure/sheets/sheets.port';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';
import { RestoreService } from './restore.service';

/**
 * Backup, and the driver choice behind it.
 *
 * `SHEETS_ENABLED` picks the adapter, exactly as `STORAGE_DRIVER` picks a
 * storage driver. The local adapter is the default and is a real backup target
 * writing real CSVs, not a mock — see ADR-0023 for why that distinction is the
 * whole reason 10.1 could be built and verified with no Google service account
 * in existence (question E7).
 */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_NAMES.SHEETS_SYNC })],
  controllers: [BackupController],
  providers: [
    {
      provide: SheetsPort,
      inject: [AppConfigService, StorageService, PinoLogger],
      useFactory: (
        config: AppConfigService,
        storage: StorageService,
        logger: PinoLogger,
      ): SheetsPort => {
        if (config.sheets.enabled) {
          logger.setContext('BackupModule');
          logger.info('Sheets backup: GOOGLE adapter selected');
          return new GoogleSheetsAdapter(config, logger);
        }
        return new LocalFileSheetsAdapter(storage, logger);
      },
    },
    BackupService,
    RestoreService,
  ],
  exports: [BackupService, RestoreService, SheetsPort],
})
export class BackupModule {}
