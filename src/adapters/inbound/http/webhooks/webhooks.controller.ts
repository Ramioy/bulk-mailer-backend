import { createHash } from 'node:crypto';

import { Controller, HttpCode, Inject, NotFoundException, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { Adapters } from '../../../../composition/adapters';
import type { DeliveryUseCases } from '../../../../composition/delivery-use-cases';
import { ADAPTERS, DELIVERY_USE_CASES } from '../../../../composition/tokens';
import { APP_CONFIG, type AppConfig } from '../../../../config/app-config';
import { Public } from '../auth/public.decorator';
import { parseZeptoMailWebhook, verifyZeptoMailWebhook } from '../../webhooks/zeptomail-webhook';

/**
 * ZeptoMail delivery events (§12.5): public, outside user authentication, authenticated by the custom
 * authorization header and the HMAC `producer-signature`. The raw event is stored and 200 is answered at once;
 * processing is asynchronous. A repeated webhook_request_id is answered 200 and ignored.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(
    @Inject(DELIVERY_USE_CASES) private readonly useCases: DeliveryUseCases,
    @Inject(ADAPTERS) private readonly adapters: Adapters,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('zeptomail')
  @HttpCode(200)
  async zeptomail(@Req() request: FastifyRequest): Promise<Record<string, never>> {
    const secrets = this.adapters.webhookSecrets;
    if (!secrets) throw new NotFoundException();
    const raw = typeof request.body === 'string' ? request.body : '';
    const receivedAt = this.adapters.clock.now();
    const verified = verifyZeptoMailWebhook(request.headers, raw, receivedAt, secrets);
    if (!verified.ok) throw new UnauthorizedException({ error: 'INVALID_WEBHOOK' });

    const parsed = parseZeptoMailWebhook(verified.json, receivedAt, this.config.redirectAllEmailTo);
    // Without a webhook_request_id, the content identifies the delivery (a resend of the same body is a duplicate).
    const webhookRequestId = parsed.webhookRequestId ?? `sha256:${createHash('sha256').update(verified.json).digest('hex')}`;
    await this.useCases.recordWebhook.execute({ webhookRequestId, provider: 'ZEPTOMAIL', receivedAt, body: verified.json, events: parsed.events });
    return {};
  }
}
