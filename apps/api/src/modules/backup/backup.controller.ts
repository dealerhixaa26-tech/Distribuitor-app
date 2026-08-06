import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { PERMISSIONS, QUEUE_NAMES } from '@hixaa/contracts';
import type { Queue } from 'bullmq';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { BackupService } from './backup.service';
import { RestoreService } from './restore.service';

@ApiTags('Backup')
@Controller('backup')
export class BackupController {
  constructor(
    private readonly backup: BackupService,
    private readonly restore: RestoreService,
    @InjectQueue(QUEUE_NAMES.SHEETS_SYNC) private readonly queue: Queue,
  ) {}

  @Get('jobs')
  @RequirePermission(PERMISSIONS.BACKUP_READ)
  @ApiOperation({
    summary: 'Recent backup and restore runs',
    description:
      'Includes rowsExpected alongside rowsProcessed. A run that exported 0 of 4,812 rows is ' +
      'the failure this table exists to make visible.',
  })
  async jobs(@Query('limit') limit?: string) {
    return this.backup.listJobs(Math.min(Number(limit) || 50, 200));
  }

  @Post('sheets/sync')
  @HttpCode(202)
  @RequirePermission(PERMISSIONS.BACKUP_RUN)
  @ApiOperation({
    summary: 'Trigger a Sheets backup now',
    description:
      'Returns 202 immediately and runs in the WORKER — the API never calls the Sheets API, so ' +
      'no third-party call sits on a request path (ADR-0005, docs/07 §2).',
  })
  async sync(@CurrentUser('id') actorId: string) {
    const job = await this.queue.add('sheets.sync', { triggeredById: actorId });
    return { accepted: true, jobId: job.id };
  }

  @Post('sheets/restore')
  @RequirePermission(PERMISSIONS.BACKUP_RESTORE)
  @ApiOperation({
    summary: 'Compare a backup sheet against the live table (DRY RUN)',
    description:
      'Dry run by default and, at present, always: it reports what a restore WOULD change and ' +
      'writes nothing. Passing confirm=true returns an explicit refusal explaining why applying ' +
      'a Sheets restore is not the recovery path — pg_dump is (ADR-0024).',
  })
  async restoreSheet(
    @Body() body: { entity?: string; confirm?: boolean },
    @CurrentUser('id') actorId: string,
  ) {
    if (body.confirm) this.restore.applyRestore();
    return this.restore.dryRun(body.entity ?? '', actorId);
  }
}
