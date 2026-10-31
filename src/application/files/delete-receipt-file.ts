import { isBlock } from '../../domain/block/block';
import { Period } from '../../domain/period/period';
import { toSha256 } from '../../domain/receipt/sha256';
import type { StoredFileKey } from '../../ports/receipt-file-store';
import type { FileDependencies } from './file-dependencies';

/** The file key a job carries; invalid payloads are a bug in whoever queued them. */
export function fileKeyOf(payload: Readonly<Record<string, unknown>>, sha256 = payload.sha256): StoredFileKey {
  const period = Period.parse(String(payload.period));
  const block = String(payload.block);
  if (!period || !isBlock(block)) throw new Error(`Invalid file key ${JSON.stringify(payload)}`);
  return { period, block, sha256: toSha256(String(sha256)) };
}

/**
 * D41: deletes the file of a receipt that no longer needs it. Idempotent: a missing file is a success. The receipt is
 * read again inside the serial executor, where an upload decides: if the same content was uploaded again meanwhile
 * (e.g. for a Resend, A2) and is available in that place, the file is kept.
 */
export class DeleteReceiptFile {
  constructor(private readonly deps: Pick<FileDependencies, 'repository' | 'fileStore' | 'serial'>) {}

  execute(key: StoredFileKey): Promise<'DELETED' | 'KEPT'> {
    const { repository, fileStore, serial } = this.deps;
    return serial.run(async () => {
      const receipt = await repository.receipts.get(key.sha256);
      if (receipt?.fileAvailable && receipt.period.equals(key.period) && receipt.block === key.block) return 'KEPT';
      await fileStore.delete(key);
      return 'DELETED';
    });
  }
}

/** D41/D42: the files of a processed batch, only those of the receipts listed when it was processed. */
export class PurgeBatchFiles {
  private readonly delete: DeleteReceiptFile;

  constructor(deps: Pick<FileDependencies, 'repository' | 'fileStore' | 'serial'>) {
    this.delete = new DeleteReceiptFile(deps);
  }

  async execute(payload: Readonly<Record<string, unknown>>): Promise<number> {
    const sha256s = Array.isArray(payload.sha256s) ? payload.sha256s : [];
    let deleted = 0;
    for (const sha256 of sha256s) if ((await this.delete.execute(fileKeyOf(payload, sha256))) === 'DELETED') deleted += 1;
    return deleted;
  }
}
