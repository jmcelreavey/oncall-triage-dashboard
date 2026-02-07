import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  async list() {
    return this.reports.list();
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.reports.get(id);
  }

  @Post('open-file')
  openFile(
    @Body()
    payload: {
      repoPath?: string;
      path: string;
      line?: number;
    },
  ) {
    return this.reports.openFile(payload);
  }

  @Post('clear')
  async clear() {
    return this.reports.clear();
  }

  @Get(':id/download')
  async downloadFiles(@Param('id') id: string) {
    return this.reports.downloadFiles(id);
  }

  @Get(':id/inputs')
  async getRunInputs(@Param('id') id: string) {
    return this.reports.getRunInputs(id);
  }
}
