import { afterEach, describe, expect, it } from 'vitest';

import { startTestApp, type TestContext } from './support/test-app';

const ALLOWED = 'https://bulk-mailer.anutibara.com';

describe('CORS for the web client (D49)', () => {
  let ctx: TestContext;
  afterEach(() => ctx.app.close());

  const preflight = (url: string, origin: string, method: string, headers: string) =>
    ctx.app.inject({ method: 'OPTIONS', url, headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': headers } });

  it('answers the preflight of an allowed origin with the methods and headers the API uses', async () => {
    ctx = await startTestApp({ CORS_ALLOWED_ORIGINS: `${ALLOWED},http://localhost:5173` });
    const upload = await preflight('/batches/2026-10/CASH/receipts', ALLOWED, 'POST', 'authorization,content-type');
    expect(upload.statusCode).toBe(204);
    expect(upload.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(String(upload.headers['access-control-allow-methods'])).toContain('POST');
    expect(String(upload.headers['access-control-allow-headers'])).toBe('authorization, content-type, last-event-id');
    expect(upload.headers['access-control-max-age']).toBe('600');
    expect(upload.headers['access-control-allow-credentials']).toBeUndefined();

    const events = await preflight('/executions/x/events', 'http://localhost:5173', 'GET', 'authorization,last-event-id');
    expect(events.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(String(events.headers['access-control-allow-headers'])).toContain('last-event-id');

    // A real request from the allowed origin carries the header too, and still needs the JWT.
    const unauthenticated = await ctx.app.inject({ method: 'GET', url: '/alerts', headers: { origin: ALLOWED } });
    expect([unauthenticated.statusCode, unauthenticated.headers['access-control-allow-origin']]).toEqual([401, ALLOWED]);
  });

  it('gives no CORS header to another origin, and leaves requests without Origin (the webhook) alone', async () => {
    ctx = await startTestApp({ CORS_ALLOWED_ORIGINS: ALLOWED });
    const other = await preflight('/batches/2026-10/CASH/receipts', 'https://evil.example.com', 'POST', 'authorization');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    const webhook = await ctx.app.inject({ method: 'POST', url: '/webhooks/zeptomail', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'data=%7B%7D' });
    expect([webhook.statusCode, webhook.json()]).toEqual([401, { error: 'INVALID_WEBHOOK' }]);
    expect(webhook.headers['access-control-allow-origin']).toBeUndefined();
    expect((await ctx.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('is off without CORS_ALLOWED_ORIGINS (outside production)', async () => {
    ctx = await startTestApp();
    const response = await preflight('/batches/2026-10/CASH/receipts', ALLOWED, 'POST', 'authorization');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
