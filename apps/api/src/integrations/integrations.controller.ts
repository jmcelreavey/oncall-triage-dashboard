import { Body, Controller, Get, Post } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import type { IntegrationName } from './integrations.service';

@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  async list() {
    return this.integrations.getStatuses();
  }

  @Get('config')
  config() {
    return this.integrations.getConfig();
  }

  @Post('test')
  async test(
    @Body('name') name: IntegrationName,
    @Body() body: Record<string, any>,
  ) {
    const overrides = body?.overrides as Record<string, string> | undefined;
    return this.integrations.test(name, overrides);
  }

  @Post('configure')
  async configure(@Body() body: Record<string, any>) {
    return this.integrations.configure(body);
  }
}
