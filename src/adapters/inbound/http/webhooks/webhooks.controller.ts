import { createHash } from 'node:crypto';

import { Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { DeliveryUseCases } from '../../../../composition/delivery-use-cases';
import { CLOCK, DELIVERY_USE_CASES, WEBHOOK_SECRETS } from '../../../../composition/tokens';
import type { Clock } from '../../../../ports/clock';
import { APP_CONFIG, type AppConfig } from '../../../../config/app-config';
import { Public } from '../auth/public.decorator';
import { parseZeptoMailWebhook, verifyZeptoMailWebhook, type ZeptoMailWebhookSecrets } from '../../webhooks/zeptomail-webhook';

/**
 * ZeptoMail delivery events (§12.5, D20). Reception has no operator session (ZeptoMail cannot sign in): it is
 * authenticated with ZeptoMail's credentials, the custom authorization header and the HMAC `producer-signature`, and
 * returns no data. The raw event is stored and 200 is answered at once; processing is asynchronous. A repeated
 * webhook_request_id is answered 200 and ignored. Querying what was received requires the operator's JWT.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(
    @Inject(DELIVERY_USE_CASES) private readonly useCases: DeliveryUseCases,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WEBHOOK_SECRETS) private readonly secrets: ZeptoMailWebhookSecrets | undefined,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('zeptomail')
  @HttpCode(200)
  async zeptomail(@Req() request: FastifyRequest): Promise<Record<string, never>> {
    const secrets = this.secrets;
    if (!secrets) throw new NotFoundException();
    const raw = typeof request.body === 'string' ? request.body : '';
    const receivedAt = this.clock.now();
    const verified = verifyZeptoMailWebhook(request.headers, raw, receivedAt, secrets);
    if (!verified.ok) throw new UnauthorizedException({ error: 'INVALID_WEBHOOK' });

    const parsed = parseZeptoMailWebhook(verified.json, receivedAt, this.config.redirectAllEmailTo);
    // Without a webhook_request_id, the content identifies the delivery (a resend of the same body is a duplicate).
    const webhookRequestId = parsed.webhookRequestId ?? `sha256:${createHash('sha256').update(verified.json).digest('hex')}`;
    await this.useCases.recordWebhook.execute({
      webhookRequestId,
      provider: 'ZEPTOMAIL',
      receivedAt,
      body: verified.json,
      events: parsed.events,
      ...(parsed.notes ? { parseNotes: parsed.notes } : {}),
    });
    return {};
  }

  /** Received webhooks, most recent first, with their events and whether they were processed (JWT). */
  @Get('zeptomail/events')
  async events(@Query('limit') limit?: string) {
    return this.useCases.webhooks.execute(Number(limit ?? '50'));
  }

  /** One received webhook, with its raw body (JWT). */
  @Get('zeptomail/events/:webhookRequestId')
  async event(@Param('webhookRequestId') webhookRequestId: string) {
    const webhook = await this.useCases.webhook.execute(webhookRequestId);
    if (!webhook) throw new NotFoundException({ error: 'WEBHOOK_NOT_FOUND' });
    return webhook;
  }
}
