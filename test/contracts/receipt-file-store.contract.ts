import { createHash } from 'node:crypto';

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

    it('D41: lists every stored file with its modification time', async () => {
      expect(await store.list()).toEqual([]);
      const before = Date.now() - 60_000;
      await store.save(key, new Uint8Array([1]));
      await store.save({ ...key, block: 'ANGLO', sha256: hashOf('b') }, new Uint8Array([2]));
      const listed = await store.list();
      expect(listed.map((f) => `${f.period.toString()}/${f.block}/${f.sha256}`).sort()).toEqual([`2026-10/ANGLO/${hashOf('b')}`, `2026-10/CASH/${hashOf('a')}`]);
      expect(listed.every((f) => f.modifiedAt instanceof Date && f.modifiedAt.getTime() >= before)).toBe(true);
      await store.delete(key);
      expect((await store.list()).map((f) => f.sha256)).toEqual([hashOf('b')]);
    });

    it('D48: stages a stream while hashing it, then commits it into place or discards it', async () => {
      async function* chunks(...parts: string[]) {
        for (const part of parts) yield new Uint8Array(Buffer.from(part));
      }
      const staged = await store.stage(chunks('%PDF-', '1.7 ', 'hello'));
      const expected = new Uint8Array(Buffer.from('%PDF-1.7 hello'));
      expect(staged.size).toBe(expected.length);
      expect(staged.sha256).toBe(createHash('sha256').update(expected).digest('hex'));
      expect(await store.readStaged(staged)).toEqual(expected);
      expect((await store.listStaged()).map((s) => s.stagingId)).toEqual([staged.stagingId]);
      expect(await store.list()).toEqual([]);

      await store.commitStaged({ ...key, sha256: staged.sha256 }, staged);
      expect(await store.read({ ...key, sha256: staged.sha256 })).toEqual(expected);
      expect(await store.listStaged()).toEqual([]);
      await store.discardStaged(staged);

      const other = await store.stage(chunks('x'));
      await store.discardStaged(other);
      expect(await store.listStaged()).toEqual([]);
    });

    it('D48: a stream that fails while staged leaves nothing behind', async () => {
      async function* failing() {
        yield new Uint8Array([1, 2, 3]);
        throw new Error('client went away');
      }
      await expect(store.stage(failing())).rejects.toThrow('client went away');
      expect(await store.listStaged()).toEqual([]);
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
