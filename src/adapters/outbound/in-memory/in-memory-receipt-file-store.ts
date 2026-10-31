import type { Block } from '../../../domain/block/block';
import type { Period } from '../../../domain/period/period';
import type { ReceiptFileStore, StoredFileKey } from '../../../ports/receipt-file-store';

const batchPrefix = (period: Period, block: Block) => `${period.toString()}/${block}/`;
const keyOf = (key: StoredFileKey) => `${batchPrefix(key.period, key.block)}${key.sha256}`;

export class InMemoryReceiptFileStore implements ReceiptFileStore {
  private readonly files = new Map<string, Uint8Array>();

  async save(key: StoredFileKey, content: Uint8Array): Promise<void> {
    this.files.set(keyOf(key), new Uint8Array(content));
  }

  async read(key: StoredFileKey): Promise<Uint8Array | undefined> {
    const content = this.files.get(keyOf(key));
    return content && new Uint8Array(content);
  }

  async delete(key: StoredFileKey): Promise<void> {
    this.files.delete(keyOf(key));
  }

  async purgeBatch(period: Period, block: Block): Promise<number> {
    const prefix = batchPrefix(period, block);
    const keys = [...this.files.keys()].filter((k) => k.startsWith(prefix));
    for (const key of keys) this.files.delete(key);
    return keys.length;
  }
}
