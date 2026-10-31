import type { AdminDependencies } from '../application/admin/admin-dependencies';
import { ArchiveCopy } from '../application/admin/archive-copy';
import { ListConcepts, ManageConcepts } from '../application/admin/manage-concepts';
import { AcknowledgeAlert, ListAlerts } from '../application/alerts/alert-queries';
import { ListDeadEvents, RetryDeadEvent } from '../application/events/dead-events';
import { GetInstanceStatus } from '../application/instance/get-instance-status';
import type { InstanceLease } from '../ports/instance-lease';

export interface AdminUseCases {
  readonly listConcepts: ListConcepts;
  readonly concepts: ManageConcepts;
  readonly archiveCopy: ArchiveCopy;
  readonly deadEvents: ListDeadEvents;
  readonly retryDeadEvent: RetryDeadEvent;
  readonly alerts: ListAlerts;
  readonly acknowledgeAlert: AcknowledgeAlert;
  readonly instance: GetInstanceStatus;
}

export function adminUseCases(deps: AdminDependencies & { readonly instanceLease: InstanceLease; readonly instanceId: string }): AdminUseCases {
  return {
    listConcepts: new ListConcepts(deps),
    concepts: new ManageConcepts(deps),
    archiveCopy: new ArchiveCopy(deps),
    deadEvents: new ListDeadEvents(deps),
    retryDeadEvent: new RetryDeadEvent(deps),
    alerts: new ListAlerts(deps),
    acknowledgeAlert: new AcknowledgeAlert(deps),
    instance: new GetInstanceStatus(deps),
  };
}
