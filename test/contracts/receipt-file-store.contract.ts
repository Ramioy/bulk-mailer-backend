import { beforeEach, describe, expect, it } from 'vitest';

import type { ReceiptFileStore } from '../../src/ports/receipt-file-store';
import { hashOf, OCT_2026 } from '../support/builders';

export function receiptFileStoreContract(name: string, create: () => Promise<ReceiptFileStore>): void {
  describe(`ReceiptFileStore contract: ${name}`, () => {
    let store: ReceiptFileStore;
    const key = { period: OCT_2026, block: 'CASH' as const, sha256: hashOf('a') };

    beforeEach(async () => {
      store = await create();
    });

    it('saves and reads the exact bytes', async () => {
      const content = new Uint8Array([37, 80, 68, 70, 0, 255]);
      await store.save(key, content);
      expect(await store.read(key)).toEqual(content);
    });

    it('returns undefined for a file that is not stored, and after delete', async () => {
      expect(await store.read(key)).toBeUndefined();
      await store.save(key, new Uint8Array([1]));
      await store.delete(key);
      expect(await store.read(key)).toBeUndefined();
      await store.delete(key);
    });

    it('purges only the files of the given batch', async () => {
      await store.save(key, new Uint8Array([1]));
      await store.save({ ...key, sha256: hashOf('b') }, new Uint8Array([2]));
      await store.save({ ...key, block: 'ANGLO' }, new Uint8Array([3]));
      expect(await store.purgeBatch(OCT_2026, 'CASH')).toBe(2);
      expect(await store.read(key)).toBeUndefined();
      expect(await store.read({ ...key, block: 'ANGLO' })).toEqual(new Uint8Array([3]));
      expect(await store.purgeBatch(OCT_2026, 'CASH')).toBe(0);
    });
  });
}
