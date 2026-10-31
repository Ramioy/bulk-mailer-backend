import { describe, expect, it } from 'vitest';

import type { InstanceLease } from '../../src/ports/instance-lease';

/** Behaviour every InstanceLease adapter must have (D47). `expire` ends the current lease as if its TTL had elapsed. */
export function instanceLeaseContract(name: string, create: () => Promise<{ lease: InstanceLease; expire: () => Promise<void> }>): void {
  describe(`InstanceLease contract: ${name}`, () => {
    it('one holder at a time; the holder renews; another takes it only once it expired', async () => {
      const { lease, expire } = await create();
      expect(await lease.current()).toBeUndefined();
      expect(await lease.acquire('a', 30)).toBe(true);
      expect(await lease.acquire('b', 30)).toBe(false);
      expect(await lease.acquire('a', 30)).toBe(true);
      expect(await lease.renew('a', 30)).toBe(true);
      expect(await lease.renew('b', 30)).toBe(false);
      expect(await lease.current()).toMatchObject({ holder: 'a', live: true });

      await expire();
      // An expired lease is not renewed: its holder must step down and take it again.
      expect(await lease.renew('a', 30)).toBe(false);
      expect(await lease.current()).toMatchObject({ holder: 'a', live: false });
      expect(await lease.acquire('b', 30)).toBe(true);
      expect(await lease.acquire('a', 30)).toBe(false);
      expect(await lease.current()).toMatchObject({ holder: 'b', live: true });
    });

    it('released by its holder only, it can be taken at once', async () => {
      const { lease } = await create();
      await lease.acquire('a', 30);
      await lease.release('b');
      expect(await lease.acquire('b', 30)).toBe(false);
      await lease.release('a');
      expect(await lease.current()).toMatchObject({ holder: 'a', live: false });
      expect(await lease.acquire('b', 30)).toBe(true);
    });

    it('two instances asking at the same time: exactly one gets it', async () => {
      const { lease } = await create();
      const results = await Promise.all(['a', 'b', 'c', 'd'].map((id) => lease.acquire(id, 30)));
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });
}
