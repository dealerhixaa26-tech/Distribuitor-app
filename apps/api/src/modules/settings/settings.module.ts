import { Global, Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/**
 * Global: the company's statutory identity and finance defaults are read by
 * invoicing, ordering, and numbering, so exporting this once beats importing
 * it into every module that needs a GSTIN.
 */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
