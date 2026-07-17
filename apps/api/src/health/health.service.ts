import { Injectable } from '@nestjs/common';

export interface HealthStatus {
  service: 'hive-chameleon-api';
  status: 'ok';
  uptimeSeconds: number;
  version: string;
}

@Injectable()
export class HealthService {
  private readonly startedAt = process.hrtime.bigint();

  getLiveness(): HealthStatus {
    return this.status();
  }

  getReadiness(): HealthStatus {
    // Dependency checks are added by their owning foundation modules. Until then, readiness is
    // intentionally equivalent to process health rather than pretending dependencies exist.
    return this.status();
  }

  private status(): HealthStatus {
    const elapsedNanoseconds = process.hrtime.bigint() - this.startedAt;

    return {
      service: 'hive-chameleon-api',
      status: 'ok',
      uptimeSeconds: Number(elapsedNanoseconds / 1_000_000_000n),
      version: process.env.npm_package_version ?? '0.1.0',
    };
  }
}
