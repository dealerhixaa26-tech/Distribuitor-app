import { Global, Module } from '@nestjs/common';
import { ClockService } from '../../common/utils/clock.service';
import { AuditService } from './audit.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, AuditService, ClockService],
  exports: [PrismaService, AuditService, ClockService],
})
export class DatabaseModule {}
