import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';

import { READINESS } from '../../../composition/tokens';
import type { ReadinessProbe } from '../../../ports/readiness-probe';
import { Public } from './auth/public.decorator';

/**
 * Public and minimal (D20). D50 (B8): it checks the database and the volume; when one fails it answers 503 with which,
 * and nothing else.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS) private readonly readiness: ReadinessProbe) {}

  @Get()
  async check(): Promise<{ status: 'ok' }> {
    const checks = await this.readiness.check();
    if (Object.values(checks).some((ok) => !ok)) throw new ServiceUnavailableException({ status: 'degraded', checks });
    return { status: 'ok' };
  }
}
