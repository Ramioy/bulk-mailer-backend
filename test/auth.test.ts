import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApp, TEST_PASSWORD, type TestContext } from './support/test-app';

describe('authentication over HTTP', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const post = (url: string, payload: object) => ctx.app.inject({ method: 'POST', url, payload });
  const me = (token?: string) =>
    ctx.app.inject({ method: 'GET', url: '/auth/me', headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
  const signIn = async () => (await post('/auth/sign-in', { username: 'operador', password: TEST_PASSWORD })).json();

  it('D58: answers the same code for an unknown user and a wrong password, and audits the real reason', async () => {
    const unknown = await post('/auth/sign-in', { username: 'nadie', password: 'x' });
    const wrong = await post('/auth/sign-in', { username: 'operador', password: 'x' });
    expect([unknown.statusCode, unknown.json()]).toEqual([401, { error: 'INVALID_CREDENTIALS' }]);
    expect([wrong.statusCode, wrong.json()]).toEqual([401, { error: 'INVALID_CREDENTIALS' }]);

    const audit = await ctx.repository.audit.list();
    expect(audit.filter((a) => a.action === 'SIGN_IN_FAILED').map((a) => [a.actor, a.newValue])).toEqual([
      ['nadie', 'UNKNOWN_USER'],
      ['operador', 'WRONG_PASSWORD'],
    ]);
  });

  it('rejects malformed requests', async () => {
    const response = await post('/auth/sign-in', { username: 'operador' });
    expect([response.statusCode, response.json()]).toEqual([400, expect.objectContaining({ error: 'INVALID_REQUEST', field: 'password' })]);
  });

  it('protects every route except the public ones', async () => {
    expect((await me()).statusCode).toBe(401);
    expect((await me('not-a-token')).json()).toMatchObject({ error: 'INVALID_ACCESS_TOKEN' });

    const session = await signIn();
    const response = await me(session.accessToken);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ operatorId: 'op-1', username: 'operador' });
  });

  it('issues a 15-minute access token and an absolute 8-hour session', async () => {
    const now = ctx.clock.now().getTime();
    const session = await signIn();
    expect(new Date(session.accessExpiresAt).getTime() - now).toBe(15 * 60_000);
    expect(new Date(session.refreshExpiresAt).getTime() - now).toBe(8 * 3_600_000);
  });

  it('renews with a single-use refresh token, keeping the absolute expiry', async () => {
    const session = await signIn();
    ctx.clock.advance(16 * 60_000);
    expect((await me(session.accessToken)).statusCode).toBe(401);

    const renewed = (await post('/auth/refresh', { refreshToken: session.refreshToken })).json();
    expect(renewed.refreshExpiresAt).toBe(session.refreshExpiresAt);
    expect((await me(renewed.accessToken)).statusCode).toBe(200);

    const reused = await post('/auth/refresh', { refreshToken: session.refreshToken });
    expect([reused.statusCode, reused.json()]).toEqual([401, expect.objectContaining({ error: 'INVALID_REFRESH_TOKEN' })]);
  });

  it('cannot renew past the absolute session expiry; the last access token is capped at it', async () => {
    let session = await signIn();
    for (let i = 0; i < 33; i += 1) {
      ctx.clock.advance(14 * 60_000);
      session = (await post('/auth/refresh', { refreshToken: session.refreshToken })).json();
    }
    // 33 × 14 min = 7 h 42 min: still inside the session; the access token ends with the session, not 15 min later.
    expect(new Date(session.accessExpiresAt).getTime()).toBeLessThanOrEqual(new Date(session.refreshExpiresAt).getTime());
    ctx.clock.advance(20 * 60_000);
    expect((await post('/auth/refresh', { refreshToken: session.refreshToken })).statusCode).toBe(401);
  });

  it('signing out ends the session at once, also for its unexpired access token', async () => {
    const session = await signIn();
    expect((await me(session.accessToken)).statusCode).toBe(200);
    expect((await post('/auth/sign-out', { refreshToken: session.refreshToken })).statusCode).toBe(204);
    expect((await me(session.accessToken)).statusCode).toBe(401);
    expect((await post('/auth/refresh', { refreshToken: session.refreshToken })).statusCode).toBe(401);
    expect((await post('/auth/sign-out', { refreshToken: session.refreshToken })).statusCode).toBe(204);
  });

  it('audits sign-in, renewal and sign-out', async () => {
    const actions = (await ctx.repository.audit.list()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['SIGN_IN', 'SESSION_RENEWED', 'SIGN_OUT']));
    expect((await ctx.repository.audit.list()).every((a) => a.at instanceof Date)).toBe(true);
  });
});
