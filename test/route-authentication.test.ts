import type { RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApp, type TestContext } from './support/test-app';

/**
 * D20: every route requires the operator's JWT, except this explicit list. The provider webhook has no operator
 * session but its own credentials, and returns no data.
 */
const WITHOUT_OPERATOR_TOKEN = new Map<string, number>([
  ['GET /health', 200],
  ['POST /auth/sign-in', 400],
  ['POST /auth/refresh', 400],
  ['POST /auth/sign-out', 400],
  ['POST /webhooks/zeptomail', 401],
]);

describe('route authentication (D20)', () => {
  let ctx: TestContext;
  const routes: string[] = [];

  beforeAll(async () => {
    ctx = await startTestApp({}, {
      beforeInit: (app) =>
        app.getHttpAdapter().getInstance().addHook('onRoute', (route: RouteOptions) => {
          for (const method of [route.method].flat()) if (method !== 'HEAD' && method !== 'OPTIONS') routes.push(`${method} ${route.url}`);
        }),
    });
  });

  afterAll(() => ctx.app.close());

  it('knows the routes', () => {
    expect(routes).toEqual(expect.arrayContaining(['GET /webhooks/zeptomail/events', 'POST /receipts/:sha256/verify-delivery', 'GET /suppressions', 'PATCH /concepts/:key', 'PUT /settings/archive-copy', 'POST /executions/:executionId/abort', 'GET /outbox/dead', 'POST /outbox/dead/:eventId/retry', 'GET /alerts', 'POST /alerts/:alertId/acknowledge', 'GET /instance', 'POST /batches/:period/:block/release-files']));
  });

  it('answers 401 INVALID_ACCESS_TOKEN to every query and command without the operator token', async () => {
    const open: string[] = [];
    for (const route of routes.filter((r) => !WITHOUT_OPERATOR_TOKEN.has(r))) {
      const [method, path] = route.split(' ') as [string, string];
      const url = path.replace(':period', '2026-10').replace(':block', 'CASH').replace(/:[A-Za-z0-9]+/g, 'x');
      const response = await ctx.app.inject({ method: method as 'GET', url });
      if (response.statusCode !== 401 || response.json().error !== 'INVALID_ACCESS_TOKEN') open.push(`${route} → ${response.statusCode}`);
    }
    expect(open).toEqual([]);
  });

  it('lists exactly the routes reachable without the operator token, and none of them returns data without credentials', async () => {
    expect(routes.filter((r) => WITHOUT_OPERATOR_TOKEN.has(r)).sort()).toEqual([...WITHOUT_OPERATOR_TOKEN.keys()].sort());
    const answers = new Map<string, number>();
    for (const route of WITHOUT_OPERATOR_TOKEN.keys()) {
      const [method, url] = route.split(' ') as [string, string];
      answers.set(route, (await ctx.app.inject({ method: method as 'GET', url })).statusCode);
    }
    expect(answers).toEqual(WITHOUT_OPERATOR_TOKEN);
  });

  it('rejects the webhook reception without ZeptoMail credentials, and it returns no data even with them', async () => {
    const response = await ctx.app.inject({ method: 'POST', url: '/webhooks/zeptomail', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'data=%7B%7D' });
    expect([response.statusCode, response.json()]).toEqual([401, { error: 'INVALID_WEBHOOK' }]);
    expect((await ctx.app.inject({ method: 'GET', url: '/webhooks/zeptomail/events' })).statusCode).toBe(401);
  });
});
