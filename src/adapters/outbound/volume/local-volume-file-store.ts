import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Block } from '../../../domain/block/block';
import type { Period } from '../../../domain/period/period';
import type { ReceiptFileStore, StoredFileKey } from '../../../ports/receipt-file-store';

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** `<root>/<YYYY-MM>/<BLOCK>/<sha256>.pdf`. Writes are atomic (temporary file + rename). */
export class LocalVolumeFileStore implements ReceiptFileStore {
  constructor(private readonly root: string) {}

  async save(key: StoredFileKey, content: Uint8Array): Promise<void> {
    const dir = this.batchDir(key.period, key.block);
    await mkdir(dir, { recursive: true });
    const temporary = join(dir, `.${randomUUID()}.tmp`);
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, this.path(key));
  }

  async read(key: StoredFileKey): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async delete(key: StoredFileKey): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async purgeBatch(period: Period, block: Block): Promise<number> {
    const dir = this.batchDir(period, block);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
    await rm(dir, { recursive: true, force: true });
    return names.filter((n) => n.endsWith('.pdf')).length;
  }

  private batchDir(period: Period, block: Block): string {
    return join(this.root, period.toString(), block);
  }

  private path(key: StoredFileKey): string {
    return join(this.batchDir(key.period, key.block), `${key.sha256}.pdf`);
  }
}
