import type { AdminDependencies } from '../application/admin/admin-dependencies';
import { ArchiveCopy } from '../application/admin/archive-copy';
import { ListConcepts, ManageConcepts } from '../application/admin/manage-concepts';

export interface AdminUseCases {
  readonly listConcepts: ListConcepts;
  readonly concepts: ManageConcepts;
  readonly archiveCopy: ArchiveCopy;
}

export function adminUseCases(deps: AdminDependencies): AdminUseCases {
  return { listConcepts: new ListConcepts(deps), concepts: new ManageConcepts(deps), archiveCopy: new ArchiveCopy(deps) };
}
