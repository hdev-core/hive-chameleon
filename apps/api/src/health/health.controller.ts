import { Controller, Get, Inject } from '@nestjs/common';

import { HealthService, type HealthStatus } from './health.service';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get()
  getHealth(): HealthStatus {
    return this.healthService.getReadiness();
  }

  @Get('live')
  getLiveness(): HealthStatus {
    return this.healthService.getLiveness();
  }

  @Get('ready')
  getReadiness(): HealthStatus {
    return this.healthService.getReadiness();
  }
}
