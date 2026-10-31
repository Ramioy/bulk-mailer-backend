import type { Block } from '../../../domain/block/block';
import type { Period } from '../../../domain/period/period';
import type { ReceiptFileStore, StoredFile, StoredFileKey } from '../../../ports/receipt-file-store';

const batchPrefix = (period: Period, block: Block) => `${period.toString()}/${block}/`;
const keyOf = (key: StoredFileKey) => `${batchPrefix(key.period, key.block)}${key.sha256}`;

export class InMemoryReceiptFileStore implements ReceiptFileStore {
  private readonly files = new Map<string, { key: StoredFileKey; content: Uint8Array; modifiedAt: Date }>();

  /** `now` dates each write, as a file system does (D41). */
  constructor(private readonly now: () => Date = () => new Date()) {}

  async save(key: StoredFileKey, content: Uint8Array): Promise<void> {
    this.files.set(keyOf(key), { key: { period: key.period, block: key.block, sha256: key.sha256 }, content: new Uint8Array(content), modifiedAt: this.now() });
  }

  async read(key: StoredFileKey): Promise<Uint8Array | undefined> {
    const stored = this.files.get(keyOf(key));
    return stored && new Uint8Array(stored.content);
  }

  async list(): Promise<StoredFile[]> {
    return [...this.files.values()].map((f) => ({ ...f.key, modifiedAt: f.modifiedAt }));
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
