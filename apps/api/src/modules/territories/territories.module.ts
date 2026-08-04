import { Module } from '@nestjs/common';
import { GeographyController } from './geography.controller';
import { TerritoriesController } from './territories.controller';
import { TerritoriesService } from './territories.service';

@Module({
  controllers: [TerritoriesController, GeographyController],
  providers: [TerritoriesService],
  exports: [TerritoriesService],
})
export class TerritoriesModule {}
