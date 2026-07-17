import { describe, expect, it } from 'vitest';

import { HealthService } from './health.service';

describe('HealthService', () => {
  it('reports an explicit API liveness status', () => {
    const result = new HealthService().getLiveness();

    expect(result).toMatchObject({
      service: 'hive-chameleon-api',
      status: 'ok',
      version: '0.1.0',
    });
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
