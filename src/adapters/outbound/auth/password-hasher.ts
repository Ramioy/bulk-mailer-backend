import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/** OWASP minimum for argon2id: 19 MiB, 2 passes, 1 lane. Stored in each hash, so it can be raised later. */
export interface Argon2Params {
  /** KiB. */
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
}

export const DEFAULT_ARGON2_PARAMS: Argon2Params = { memory: 19_456, passes: 2, parallelism: 1 };

const TAG_LENGTH = 32;
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function derive(password: string, nonce: Buffer, params: Argon2Params, tagLength: number) {
  return new Promise<Buffer>((resolve, reject) => {
    argon2('argon2id', { message: password, nonce, tagLength, ...params }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

const b64 = (buffer: Buffer) => buffer.toString('base64').replace(/=+$/, '');

/** Hash in PHC string format: `$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>`. */
export async function hashPassword(password: string, params: Argon2Params = DEFAULT_ARGON2_PARAMS): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, params, TAG_LENGTH);
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const match = PHC.exec(phc);
  if (!match) return false;
  const [, memory, passes, parallelism, salt, hash] = match;
  const expected = Buffer.from(hash as string, 'base64');
  const actual = await derive(
    password,
    Buffer.from(salt as string, 'base64'),
    { memory: Number(memory), passes: Number(passes), parallelism: Number(parallelism) },
    expected.length,
  );
  return timingSafeEqual(actual, expected);
}
