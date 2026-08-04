import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, updateSettingSchema } from '@hixaa/contracts';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { SettingsService } from './settings.service';

@ApiTags('Settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.SETTING_READ)
  @ApiOperation({ summary: 'Setting categories with their entry counts' })
  async categories() {
    return this.settings.listCategories();
  }

  @Get(':category')
  @RequirePermission(PERMISSIONS.SETTING_READ)
  @ApiOperation({
    summary: 'All settings in a category',
    description:
      'Secret values are redacted. Each entry carries a `writable` flag — seeded reference ' +
      'content such as the portfolio catalogue is managed in code and reconciled on deploy.',
  })
  async listCategory(@Param('category') category: string) {
    return this.settings.listCategory(category);
  }

  @Put(':category/:key')
  @RequirePermission(PERMISSIONS.SETTING_UPDATE)
  @ApiOperation({
    summary: 'Update one setting',
    description:
      'Validated against the schema registered for this key in @hixaa/contracts. A key with ' +
      'no schema is rejected rather than stored — settings drive tax calculation and ' +
      'approval ceilings, so an unvalidated blob here is a liability.',
  })
  async update(
    @Param('category') category: string,
    @Param('key') key: string,
    @Body(zodBody(updateSettingSchema)) dto: { value: unknown },
    @CurrentUser('id') actorId: string,
  ) {
    return this.settings.update(category, key, dto.value, actorId);
  }
}
