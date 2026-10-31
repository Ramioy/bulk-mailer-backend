import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';

import { AlertType } from '../../../../domain/alert/alert';
import type { AdminUseCases } from '../../../../composition/admin-use-cases';
import { ADMIN_USE_CASES } from '../../../../composition/tokens';
import type { AuthenticatedRequest } from '../auth/bearer-auth.guard';
import { httpError } from '../http-params';

/** D46: alerts the operator works with (JWT, D20). */
@Controller('alerts')
export class AlertsController {
  constructor(@Inject(ADMIN_USE_CASES) private readonly useCases: AdminUseCases) {}

  /** Newest first. `?pending=true&type=HARD_BOUNCE&subject=…&limit=200` (at most 1000). */
  @Get()
  list(@Query('pending') pending?: string, @Query('type') type?: string, @Query('subject') subject?: string, @Query('limit') limit?: string) {
    if (pending !== undefined && pending !== 'true' && pending !== 'false') throw new BadRequestException({ error: 'INVALID_REQUEST', field: 'pending' });
    if (type !== undefined && !(Object.values(AlertType) as string[]).includes(type)) throw new BadRequestException({ error: 'INVALID_REQUEST', field: 'type' });
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) throw new BadRequestException({ error: 'INVALID_REQUEST', field: 'limit' });
    return this.useCases.alerts.execute({
      pending: pending === 'true',
      ...(type ? { type: type as AlertType } : {}),
      ...(subject !== undefined ? { subject } : {}),
      ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
    });
  }

  /** `{ "note"?: "…" }`. Audited. */
  @Post(':alertId/acknowledge')
  @HttpCode(200)
  async acknowledge(@Param('alertId') alertId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const note = (body as { note?: unknown } | undefined)?.note;
    if (note !== undefined && typeof note !== 'string') throw new BadRequestException({ error: 'INVALID_REQUEST', field: 'note' });
    const result = await this.useCases.acknowledgeAlert.execute(request.operator?.username ?? 'unknown', alertId, note);
    if (!result.ok) throw httpError(result.error);
    return result.value;
  }
}
