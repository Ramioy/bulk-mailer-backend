import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password-hasher';

describe('argon2id password hashing', () => {
  it('produces a PHC string with a random salt and verifies it', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(first).not.toBe(second);
    expect(await verifyPassword('correct horse battery staple', first)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', first)).toBe(false);
  });

  it('honours the parameters stored in the hash', async () => {
    const hash = await hashPassword('pw', { memory: 8192, passes: 1, parallelism: 1 });
    expect(hash).toContain('m=8192,t=1,p=1');
    expect(await verifyPassword('pw', hash)).toBe(true);
  });

  it('rejects anything that is not an argon2id PHC string', async () => {
    expect(await verifyPassword('pw', 'plain-text')).toBe(false);
    expect(await verifyPassword('pw', '$2b$10$bcrypthash')).toBe(false);
  });
});
