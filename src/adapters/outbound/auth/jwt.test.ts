import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { signJwt, verifyJwt } from './jwt';

const KEY = Buffer.alloc(32, 1);
const NOW = new Date('2026-10-15T15:00:00Z');
const iat = NOW.getTime() / 1000;
const claims = { sub: 'op-1', username: 'operador', sid: 's1', iat, exp: iat + 900 };

describe('HS256 JWT', () => {
  it('round-trips valid claims', () => {
    expect(verifyJwt(signJwt(claims, KEY), KEY, NOW)).toEqual(claims);
  });

  it('rejects expired tokens, at the exact expiry instant', () => {
    expect(verifyJwt(signJwt(claims, KEY), KEY, new Date((iat + 900) * 1000))).toBeUndefined();
  });

  it('rejects another key, a tampered payload and garbage', () => {
    const token = signJwt(claims, KEY);
    expect(verifyJwt(token, Buffer.alloc(32, 2), NOW)).toBeUndefined();
    const [h, , s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: 'admin' })).toString('base64url');
    expect(verifyJwt(`${h}.${forged}.${s}`, KEY, NOW)).toBeUndefined();
    expect(verifyJwt('a.b', KEY, NOW)).toBeUndefined();
  });

  it('rejects alg=none and any other header', () => {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(verifyJwt(`${none}.${payload}.`, KEY, NOW)).toBeUndefined();
    const hs512 = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
    const sig = createHmac('sha512', KEY).update(`${hs512}.${payload}`).digest('base64url');
    expect(verifyJwt(`${hs512}.${payload}.${sig}`, KEY, NOW)).toBeUndefined();
  });
});
