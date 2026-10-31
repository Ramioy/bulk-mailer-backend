import { createHmac, timingSafeEqual } from 'node:crypto';

import type { DeliveryState, IncomingDeliveryEvent } from '../../../domain/receipt/delivery-state';

export interface ZeptoMailWebhookSecrets {
  /** Agent Authentication Key: HMAC-SHA256 key of `producer-signature`. */
  readonly authenticationKey: string;
  /** Custom header configured on the webhook in ZeptoMail (§12.5): name (default `authorization`) and value. */
  readonly authorizationHeader: string;
  readonly authorizationValue: string;
  /** Maximum distance between `ts` and now; default 300 s. */
  readonly maxSkewSeconds: number;
}

export type WebhookVerification = { readonly ok: true; readonly json: string } | { readonly ok: false; readonly reason: string };

/**
 * Authenticity of a ZeptoMail webhook (https://www.zoho.com/cpaas/help/webhooks.html): the custom authorization
 * header, then `producer-signature: ts=<ms>;s=<url-encoded base64>;s-algorithm=HmacSHA256`, an HMAC-SHA256 with the
 * Authentication Key over the decoded value of the single form-encoded parameter of the body. Anything else is
 * rejected without reading the payload.
 */
export function verifyZeptoMailWebhook(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  rawBody: string,
  now: Date,
  secrets: ZeptoMailWebhookSecrets,
): WebhookVerification {
  const header = (name: string) => {
    const value = headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
  if (!safeEqual(header(secrets.authorizationHeader) ?? '', secrets.authorizationValue)) return { ok: false, reason: 'authorization header' };

  const parts = new Map(
    (header('producer-signature') ?? '').split(';').map((part) => {
      const at = part.indexOf('=');
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as const;
    }),
  );
  if (parts.get('s-algorithm') !== 'HmacSHA256') return { ok: false, reason: 'signature algorithm' };
  const ts = Number(parts.get('ts'));
  if (!Number.isFinite(ts) || Math.abs(now.getTime() - ts) > secrets.maxSkewSeconds * 1000) return { ok: false, reason: 'signature timestamp' };

  // Only the value is decoded: decoding the whole body first would turn "+" into spaces (documented validator).
  const at = rawBody.indexOf('=');
  let json: string;
  let given: Buffer;
  try {
    json = decodeURIComponent(rawBody.slice(at + 1).replaceAll('+', '%20'));
    given = Buffer.from(decodeURIComponent(parts.get('s') ?? ''), 'base64');
  } catch {
    return { ok: false, reason: 'malformed body or signature' };
  }
  if (at < 0) return { ok: false, reason: 'malformed body' };
  const expected = createHmac('sha256', Buffer.from(secrets.authenticationKey, 'utf8')).update(json, 'utf8').digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' };
  return { ok: true, json };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return b !== '' && left.length === right.length && timingSafeEqual(left, right);
}

export interface ParsedWebhook {
  readonly webhookRequestId?: string;
  readonly events: IncomingDeliveryEvent[];
}

type Json = Record<string, unknown>;

/** Event objects, normalised (lower case, letters only). Opens and clicks are not delivery events. */
const STATES: Readonly<Record<string, Exclude<DeliveryState, 'UNCONFIRMED'>>> = {
  hardbounce: 'HARD_BOUNCE',
  softbounce: 'SOFT_BOUNCE',
  fblcomplaint: 'COMPLAINT',
  feedbackloop: 'COMPLAINT',
  delivered: 'ACCEPTED',
  emaildelivered: 'ACCEPTED',
};

/**
 * Reads the delivery events of a ZeptoMail webhook. No full payload is published, so the parser is tolerant
 * (§12.7): `event_name`, `event_message`, `event_data` and `details` may be arrays or objects; the event comes from
 * `event_data.object` or `event_name`; the recipient from `bounced_recipient`, `fblFrom` or `delivered_to`, or from
 * `email_info.to` when it is the only recipient. An event without client reference cannot be correlated and is
 * dropped (the raw body is kept anyway). `redirectedTo`: outside production every email went to that test mailbox,
 * so it does not identify the recipient.
 */
export function parseZeptoMailWebhook(json: string, receivedAt: Date, redirectedTo?: string): ParsedWebhook {
  let root: Json;
  try {
    root = JSON.parse(json) as Json;
  } catch {
    return { events: [] };
  }
  const webhookRequestId = text(root.webhook_request_id);
  const names = list(root.event_name).map((n) => normalise(text(n) ?? ''));
  const events: IncomingDeliveryEvent[] = [];

  list(root.event_message).forEach((message, m) => {
    const info = (message.email_info ?? {}) as Json;
    const attemptId = text(info.client_reference);
    if (!attemptId) return;
    const onlyRecipient = singleRecipient(info);
    const data = list(message.event_data);
    data.forEach((item, d) => {
      const state = STATES[normalise(text(item.object) ?? '')] ?? STATES[names[m] ?? names[0] ?? ''];
      if (!state) return;
      const details = list(item.details);
      (details.length > 0 ? details : [{}]).forEach((detail, i) => {
        let recipient = text(detail.bounced_recipient) ?? text(detail.fblFrom) ?? text(detail.delivered_to) ?? onlyRecipient;
        if (redirectedTo && recipient?.toLowerCase() === redirectedTo.toLowerCase()) recipient = undefined;
        const reason = [text(detail.reason), text(detail.diagnostic_message)].filter(Boolean).join(' — ');
        const time = Date.parse(text(detail.time) ?? '');
        events.push({
          eventId: `${webhookRequestId ?? 'no-id'}:${m}:${d}:${i}`,
          attemptId,
          ...(recipient ? { recipient: recipient.toLowerCase() } : {}),
          state,
          ...(reason ? { reason } : {}),
          occurredAt: Number.isNaN(time) ? receivedAt : new Date(time),
          source: 'WEBHOOK',
          ...(text(message.request_id) ? { providerRequestId: text(message.request_id) } : {}),
          ...(text(info.email_reference) ? { emailReference: text(info.email_reference) } : {}),
        });
      });
    });
  });
  return { ...(webhookRequestId ? { webhookRequestId } : {}), events };
}

/** The address when the email had exactly one recipient (no cc, no bcc). */
function singleRecipient(info: Json): string | undefined {
  const all = ['to', 'cc', 'bcc'].flatMap((field) => list(info[field]));
  if (all.length !== 1) return undefined;
  const address = (all[0]?.email_address as Json | undefined)?.address ?? all[0]?.address;
  return text(address);
}

function list(value: unknown): Json[] {
  if (Array.isArray(value)) return value.filter((v): v is Json => typeof v === 'object' && v !== null);
  if (typeof value === 'object' && value !== null) return [value as Json];
  if (typeof value === 'string') return [{ value } as Json];
  return [];
}

function text(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'value' in value) return text((value as Json).value);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}
