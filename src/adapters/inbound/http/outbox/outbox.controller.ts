import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';

import type { AdminUseCases } from '../../../../composition/admin-use-cases';
import { ADMIN_USE_CASES } from '../../../../composition/tokens';
import type { AuthenticatedRequest } from '../auth/bearer-auth.guard';
import { httpError } from '../http-params';

/** D39: domain events the outbox relay gave up on (JWT, D20). */
@Controller('outbox/dead')
export class OutboxController {
  constructor(@Inject(ADMIN_USE_CASES) private readonly useCases: AdminUseCases) {}

  /** `?limit=50` (at most 500), most recently dead first. */
  @Get()
  async list(@Query('limit') limit?: string) {
    const parsed = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1) throw new BadRequestException({ error: 'INVALID_REQUEST', field: 'limit' });
    const dead = await this.useCases.deadEvents.execute(parsed);
    return {
      events: dead.map((d) => ({
        eventId: d.event.eventId,
        type: d.event.type,
        occurredAt: d.event.occurredAt,
        payload: d.event.payload,
        attempts: d.attempts,
        lastError: d.lastError ?? null,
        deadAt: d.deadAt,
      })),
    };
  }

  /** `{ "note"?: "why" }`: the relay tries it again from zero attempts. Audited. */
  @Post(':eventId/retry')
  @HttpCode(200)
  async retry(@Param('eventId') eventId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const note = (body as { note?: unknown } | undefined)?.note;
    if (note !== undefined && typeof note !== 'string') throw new BadRequestException({ error: 'INVALID_REQUEST', field: 'note' });
    const result = await this.useCases.retryDeadEvent.execute(request.operator?.username ?? 'unknown', eventId, note);
    if (!result.ok) throw httpError(result.error);
    return result.value;
  }
}
