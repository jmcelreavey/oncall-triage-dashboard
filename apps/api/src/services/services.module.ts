import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MonitorRepoMappingService } from './monitor-repo-mapping.service';

@Module({
  imports: [PrismaModule],
  providers: [MonitorRepoMappingService],
  exports: [MonitorRepoMappingService],
})
export class ServicesModule {}
