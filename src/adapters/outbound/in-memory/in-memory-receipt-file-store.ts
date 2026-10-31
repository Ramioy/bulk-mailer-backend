import type { Block } from '../../../domain/block/block';
import type { Period } from '../../../domain/period/period';
import { createHash, randomUUID } from 'node:crypto';

import { toSha256 } from '../../../domain/receipt/sha256';
import type { ReceiptFileStore, StagedFile, StoredFile, StoredFileKey } from '../../../ports/receipt-file-store';

const batchPrefix = (period: Period, block: Block) => `${period.toString()}/${block}/`;
const keyOf = (key: StoredFileKey) => `${batchPrefix(key.period, key.block)}${key.sha256}`;

export class InMemoryReceiptFileStore implements ReceiptFileStore {
  private readonly files = new Map<string, { key: StoredFileKey; content: Uint8Array; modifiedAt: Date }>();
  private readonly staging = new Map<string, { content: Uint8Array; modifiedAt: Date }>();

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

  async stage(content: AsyncIterable<Uint8Array>): Promise<StagedFile> {
    const hash = createHash('sha256');
    const chunks: Uint8Array[] = [];
    for await (const chunk of content) {
      hash.update(chunk);
      chunks.push(new Uint8Array(chunk));
    }
    const stagingId = randomUUID();
    const bytes = new Uint8Array(Buffer.concat(chunks));
    this.staging.set(stagingId, { content: bytes, modifiedAt: this.now() });
    return { stagingId, sha256: toSha256(hash.digest('hex')), size: bytes.length };
  }

  async readStaged(staged: StagedFile): Promise<Uint8Array> {
    const found = this.staging.get(staged.stagingId);
    if (!found) throw new Error(`Staged file ${staged.stagingId} not found`);
    return new Uint8Array(found.content);
  }

  async commitStaged(key: StoredFileKey, staged: StagedFile): Promise<void> {
    const found = this.staging.get(staged.stagingId);
    if (!found) throw new Error(`Staged file ${staged.stagingId} not found`);
    this.staging.delete(staged.stagingId);
    this.files.set(keyOf(key), { key: { period: key.period, block: key.block, sha256: key.sha256 }, content: found.content, modifiedAt: this.now() });
  }

  async discardStaged(staged: Pick<StagedFile, 'stagingId'>): Promise<void> {
    this.staging.delete(staged.stagingId);
  }

  async listStaged(): Promise<Array<{ stagingId: string; modifiedAt: Date }>> {
    return [...this.staging.entries()].map(([stagingId, f]) => ({ stagingId, modifiedAt: f.modifiedAt }));
  }
}
