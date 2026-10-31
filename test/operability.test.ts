import { afterEach, describe, expect, it } from 'vitest';

import { startTestApp, type TestContext } from './support/test-app';

describe('operability (D50)', () => {
  let ctx: TestContext;
  afterEach(() => ctx.app.close());

  it('B8: /health checks the database and the volume, and says which failed', async () => {
    let database = true;
    ctx = await startTestApp({}, { adapters: { readiness: { check: async () => ({ database, volume: true }) } } });
    const ok = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect([ok.statusCode, ok.json()]).toEqual([200, { status: 'ok' }]);
    database = false;
    const degraded = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect([degraded.statusCode, degraded.json()]).toEqual([503, { status: 'degraded', checks: { database: false, volume: true } }]);
  });

  it('B5: the public auth routes are rate limited per client; the attempted name is audited short and printable', async () => {
    ctx = await startTestApp({ AUTH_RATE_LIMIT_PER_MINUTE: '3' });
    const attempt = (username: string) => ctx.app.inject({ method: 'POST', url: '/auth/sign-in', payload: { username, password: 'wrong' } });
    expect((await attempt(`  evil\u0000\u001b[31m${'x'.repeat(300)}  `)).statusCode).toBe(401);
    expect((await attempt('operador')).statusCode).toBe(401);
    expect((await attempt('operador')).statusCode).toBe(401);
    const limited = await attempt('operador');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'TOO_MANY_REQUESTS' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Other routes are not limited.
    expect((await ctx.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const [first] = (await ctx.repository.audit.list()).filter((a) => a.action === 'SIGN_IN_FAILED');
    expect(first?.actor).toBe(`evil[31m${'x'.repeat(92)}…`);
    expect(first?.actor.length).toBe(101);
  });
});
