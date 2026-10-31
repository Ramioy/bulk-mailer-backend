import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JWT. Tokens are issued and read only by this backend, so the header is fixed:
 * any other algorithm (including `none`) is rejected.
 */
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

export interface AccessClaims {
  /** Operator id. */
  readonly sub: string;
  readonly username: string;
  /** Session id. */
  readonly sid: string;
  /** Seconds since epoch. */
  readonly iat: number;
  readonly exp: number;
}

const sign = (input: string, key: Buffer) => createHmac('sha256', key).update(input).digest();

export function signJwt(claims: AccessClaims, key: Buffer): string {
  const body = `${HEADER}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${body}.${sign(body, key).toString('base64url')}`;
}

/** Returns the claims only if the signature is valid and the token has not expired at `now`. */
export function verifyJwt(token: string, key: Buffer, now: Date): AccessClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [header, payload, signature] = parts as [string, string, string];
  if (header !== HEADER) return undefined;

  const expected = sign(`${header}.${payload}`, key);
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;

  let claims: Partial<AccessClaims>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<AccessClaims>;
  } catch {
    return undefined;
  }
  const { sub, username, sid, iat, exp } = claims;
  if (typeof sub !== 'string' || typeof username !== 'string' || typeof sid !== 'string') return undefined;
  if (typeof iat !== 'number' || typeof exp !== 'number') return undefined;
  if (exp * 1000 <= now.getTime()) return undefined;
  return { sub, username, sid, iat, exp };
}
