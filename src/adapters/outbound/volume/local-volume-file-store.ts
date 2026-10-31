import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type Block, isBlock } from '../../../domain/block/block';
import { Period } from '../../../domain/period/period';
import { toSha256 } from '../../../domain/receipt/sha256';
import type { ReceiptFileStore, StagedFile, StoredFile, StoredFileKey } from '../../../ports/receipt-file-store';

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * `<root>/<YYYY-MM>/<BLOCK>/<sha256>.pdf`. Writes are atomic (temporary file + rename). Uploads are staged in
 * `<root>/.staging/<uuid>` while received (D48): inside the volume, so committing is an atomic rename.
 */
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

  /**
   * Walks `<root>/<YYYY-MM>/<BLOCK>/<sha256>.pdf` (D41). Anything else (temporary `.tmp` files of a write in progress,
   * unknown names) is not a receipt file and is not listed; a file removed while walking is skipped.
   */
  async list(): Promise<StoredFile[]> {
    const found: StoredFile[] = [];
    for (const periodName of await entriesOf(this.root)) {
      const period = Period.parse(periodName);
      if (!period) continue;
      for (const block of await entriesOf(join(this.root, periodName))) {
        if (!isBlock(block)) continue;
        for (const file of await entriesOf(join(this.root, periodName, block))) {
          const match = /^([0-9a-f]{64})\.pdf$/.exec(file);
          if (!match) continue;
          const key = { period, block, sha256: toSha256(match[1] as string) };
          try {
            found.push({ ...key, modifiedAt: (await stat(this.path(key))).mtime });
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }
      }
    }
    return found;
  }

  async stage(content: AsyncIterable<Uint8Array>): Promise<StagedFile> {
    await mkdir(this.stagingDir(), { recursive: true });
    const stagingId = randomUUID();
    const path = this.stagingPath(stagingId);
    const hash = createHash('sha256');
    let size = 0;
    const handle = await open(path, 'wx', 0o600);
    try {
      for await (const chunk of content) {
        hash.update(chunk);
        size += chunk.length;
        await handle.write(chunk);
      }
    } catch (error) {
      await handle.close();
      await rm(path, { force: true });
      throw error;
    }
    await handle.close();
    return { stagingId, sha256: toSha256(hash.digest('hex')), size };
  }

  async readStaged(staged: StagedFile): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.stagingPath(staged.stagingId)));
  }

  async commitStaged(key: StoredFileKey, staged: StagedFile): Promise<void> {
    await mkdir(this.batchDir(key.period, key.block), { recursive: true });
    await rename(this.stagingPath(staged.stagingId), this.path(key));
  }

  async discardStaged(staged: Pick<StagedFile, 'stagingId'>): Promise<void> {
    await rm(this.stagingPath(staged.stagingId), { force: true });
  }

  async listStaged(): Promise<Array<{ stagingId: string; modifiedAt: Date }>> {
    const found: Array<{ stagingId: string; modifiedAt: Date }> = [];
    for (const name of await entriesOf(this.stagingDir())) {
      if (!/^[0-9a-f-]{36}$/.test(name)) continue;
      try {
        found.push({ stagingId: name, modifiedAt: (await stat(this.stagingPath(name))).mtime });
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return found;
  }

  private stagingDir(): string {
    return join(this.root, '.staging');
  }

  private stagingPath(stagingId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(stagingId)) throw new Error(`Invalid staging id ${stagingId}`);
    return join(this.stagingDir(), stagingId);
  }

  private batchDir(period: Period, block: Block): string {
    return join(this.root, period.toString(), block);
  }

  private path(key: StoredFileKey): string {
    return join(this.batchDir(key.period, key.block), `${key.sha256}.pdf`);
  }
}

async function entriesOf(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw error;
  }
}
