import type { FileDependencies } from '../application/files/file-dependencies';
import { DeleteReceiptFile, PurgeBatchFiles } from '../application/files/delete-receipt-file';
import { PurgeOrphanFiles } from '../application/files/purge-orphan-files';

export interface FileUseCases {
  readonly deleteFile: DeleteReceiptFile;
  readonly purgeBatch: PurgeBatchFiles;
  readonly purgeOrphans: PurgeOrphanFiles;
}

export function fileUseCases(deps: FileDependencies): FileUseCases {
  return { deleteFile: new DeleteReceiptFile(deps), purgeBatch: new PurgeBatchFiles(deps), purgeOrphans: new PurgeOrphanFiles(deps) };
}
