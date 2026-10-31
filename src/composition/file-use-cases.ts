import type { FileDependencies } from '../application/files/file-dependencies';
import { DeleteReceiptFile, PurgeBatchFiles } from '../application/files/delete-receipt-file';
import { PurgeOrphanFiles } from '../application/files/purge-orphan-files';
import { PurgeFinishedWork } from '../application/maintenance/purge-finished-work';

export interface FileUseCases {
  readonly deleteFile: DeleteReceiptFile;
  readonly purgeBatch: PurgeBatchFiles;
  readonly purgeOrphans: PurgeOrphanFiles;
  /** D50: housekeeping of the job table and the outbox, in the same lane. */
  readonly purgeFinishedWork: PurgeFinishedWork;
}

export function fileUseCases(deps: FileDependencies & { readonly retentionDays: number }): FileUseCases {
  return {
    deleteFile: new DeleteReceiptFile(deps),
    purgeBatch: new PurgeBatchFiles(deps),
    purgeOrphans: new PurgeOrphanFiles(deps),
    purgeFinishedWork: new PurgeFinishedWork(deps),
  };
}
