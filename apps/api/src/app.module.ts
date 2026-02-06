import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthModule } from './health/health.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReportsModule } from './reports/reports.module';
import { TriageModule } from './triage/triage.module';
import { ServicesModule } from './services/services.module';
import { EventsModule } from './events/events.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    HealthModule,
    IntegrationsModule,
    TriageModule,
    ReportsModule,
    ServicesModule,
    EventsModule,
  ],
})
export class AppModule {}
