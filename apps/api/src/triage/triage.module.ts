import { Module } from '@nestjs/common';
import { TriageController } from './triage.controller';
import { TriageService } from './triage.service';
import { ServicesModule } from '../services/services.module';

@Module({
  imports: [ServicesModule],
  controllers: [TriageController],
  providers: [TriageService],
})
export class TriageModule {}
