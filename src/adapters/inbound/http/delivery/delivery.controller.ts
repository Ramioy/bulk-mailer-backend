import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import type { DeliveryUseCases } from '../../../../composition/delivery-use-cases';
import { DELIVERY_USE_CASES } from '../../../../composition/tokens';
import type { AuthenticatedRequest } from '../auth/bearer-auth.guard';
import { blockParam, httpError, periodParam, sha256Param } from '../http-params';

const actor = (request: AuthenticatedRequest) => request.operator?.username ?? 'unknown';
const field = (body: unknown, name: string): unknown => (body as Record<string, unknown> | undefined)?.[name];

@Controller()
export class DeliveryController {
  constructor(@Inject(DELIVERY_USE_CASES) private readonly useCases: DeliveryUseCases) {}

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

  /** Manual verification of one receipt in the provider logs (D22). */
  @Post('receipts/:sha256/verify-delivery')
  @HttpCode(200)
  async verifyReceipt(@Param('sha256') sha256: string, @Req() request: AuthenticatedRequest) {
    const result = await this.useCases.verify.receipt(actor(request), sha256Param(sha256));
    if (!result.ok) throw httpError(result.error);
    return result.value;
  }

  /** Manual verification of every receipt of a batch whose delivery can still change (D22). */
  @Post('batches/:period/:block/verify-delivery')
  @HttpCode(200)
  async verifyBatch(@Param('period') period: string, @Param('block') block: string, @Req() request: AuthenticatedRequest) {
    const result = await this.useCases.verify.batch(actor(request), periodParam(period), blockParam(block));
    if (!result.ok) throw httpError(result.error);
    return result.value;
  }

  /** Local suppression list. `release` tells the interface what the operator must confirm (D19). */
  @Get('suppressions')
  suppressions() {
    return this.useCases.suppressions.execute();
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
