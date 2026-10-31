import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import type { Adapters } from '../../../../composition/adapters';
import type { DeliveryUseCases } from '../../../../composition/delivery-use-cases';
import { ADAPTERS, DELIVERY_USE_CASES } from '../../../../composition/tokens';
import type { AuthenticatedRequest } from '../auth/bearer-auth.guard';
import { httpError, sha256Param } from '../http-params';

const actor = (request: AuthenticatedRequest) => request.operator?.username ?? 'unknown';
const field = (body: unknown, name: string): unknown => (body as Record<string, unknown> | undefined)?.[name];

@Controller()
export class DeliveryController {
  constructor(
    @Inject(DELIVERY_USE_CASES) private readonly useCases: DeliveryUseCases,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
  ) {}

  /** Manual resolution of an UNCERTAIN receipt: `{ "outcome": "SENT" | "NOT_SENT", "note": "evidence" }`. */
  @Post('receipts/:sha256/resolve')
  @HttpCode(200)
  async resolve(@Param('sha256') sha256: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const outcome = field(body, 'outcome');
    const note = field(body, 'note');
    if (outcome !== 'SENT' && outcome !== 'NOT_SENT') throw new BadRequestException({ error: 'INVALID_REQUEST', field: 'outcome' });
    if (typeof note !== 'string') throw new BadRequestException({ error: 'INVALID_REQUEST', field: 'note' });
    const result = await this.useCases.resolve.execute(actor(request), sha256Param(sha256), outcome, note);
    if (!result.ok) throw httpError(result.error);
    return result.value;
  }

  /** Resend after a hard bounce or a complaint (§10.4). */
  @Post('receipts/:sha256/resend')
  @HttpCode(200)
  async resend(@Param('sha256') sha256: string, @Req() request: AuthenticatedRequest) {
    const result = await this.useCases.resend.execute(actor(request), sha256Param(sha256));
    if (!result.ok) throw httpError(result.error);
    return result.value;
  }

  /** Local suppression list. `release` tells the interface what the operator must confirm (D19). */
  @Get('suppressions')
  async suppressions() {
    return { release: this.adapters.suppressionManager.confirmation, addresses: await this.adapters.repository.suppressions.list() };
  }

  /** `{ "businessConfirmed": true, "removedInProviderConsole": true, "note": "evidence" }` (§10.3, D19). */
  @Post('suppressions/:email/release')
  @HttpCode(200)
  async release(@Param('email') email: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const note = field(body, 'note');
    if (typeof note !== 'string') throw new BadRequestException({ error: 'INVALID_REQUEST', field: 'note' });
    const result = await this.useCases.release.execute(actor(request), email, {
      businessConfirmed: field(body, 'businessConfirmed') === true,
      removedInProviderConsole: field(body, 'removedInProviderConsole') === true,
      note,
    });
    if (!result.ok) {
      const { code, ...details } = result.error;
      throw httpError(code, details);
    }
    return result.value;
  }
}
