import { Module } from '@nestjs/common';
import { DistributorKycService } from './distributor-kyc.service';
import { DistributorRelationsService } from './distributor-relations.service';
import { DistributorsController } from './distributors.controller';
import { DistributorsService } from './distributors.service';
import { NumberSequenceService } from './number-sequence.service';

@Module({
  controllers: [DistributorsController],
  providers: [
    DistributorsService,
    DistributorKycService,
    DistributorRelationsService,
    NumberSequenceService,
  ],
  // NumberSequenceService is exported because Phase 8's statutory invoice
  // series needs exactly this gapless allocator.
  exports: [DistributorsService, DistributorKycService, NumberSequenceService],
})
export class DistributorsModule {}
