import { Controller, Logger, Param, Post } from '@nestjs/common';
import { TriageService } from './triage.service';

@Controller('triage')
export class TriageController {
  private readonly logger = new Logger(TriageController.name);
  constructor(private readonly triage: TriageService) {}

  @Post('run')
  async run() {
    return this.triage.triggerRun();
  }

  @Post('continue/:id')
  async continue(@Param('id') id: string) {
    return this.triage.continueRun(id);
  }

  @Post('rerun/:id')
  async rerun(@Param('id') id: string) {
    this.logger.log(`Rerun requested for run ${id}.`);
    return this.triage.rerunRun(id);
  }

  @Post('reprocess-last-error')
  async reprocessLastError() {
    this.logger.log('Reprocess last error requested.');
    return this.triage.reprocessLastError();
  }

  @Post('clear-running')
  async clearRunning() {
    this.logger.warn('Force clear running runs requested.');
    return this.triage.forceClearRunning();
  }

  @Post('open-codex/:id')
  async openCodex(@Param('id') id: string) {
    return this.triage.openCodexSession(id);
  }

  @Post('suggest-branch/:id')
  async suggestBranch(@Param('id') id: string) {
    return this.triage.suggestBranch(id);
  }
}
