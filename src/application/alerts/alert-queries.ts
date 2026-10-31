import type { Alert, AlertType } from '../../domain/alert/alert';
import { err, ok, type Result } from '../../domain/shared/result';
import type { BulkMailerRepository } from '../../ports/bulk-mailer-repository';
import type { Clock } from '../../ports/clock';

export interface AlertQueryDependencies {
  readonly repository: BulkMailerRepository;
  readonly clock: Clock;
  readonly newId: () => string;
}

export const DEFAULT_ALERT_LIMIT = 200;
export const MAX_ALERT_LIMIT = 1000;

export interface ListAlertsQuery {
  readonly pending?: boolean;
  readonly type?: AlertType;
  readonly subject?: string;
  readonly limit?: number;
}

/** D46: the alerts the operator works with, newest first; `pending` leaves out the acknowledged ones. */
export class ListAlerts {
  constructor(private readonly deps: Pick<AlertQueryDependencies, 'repository'>) {}

  execute(query: ListAlertsQuery = {}): Promise<Alert[]> {
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? DEFAULT_ALERT_LIMIT)), MAX_ALERT_LIMIT);
    return this.deps.repository.alerts.list({ ...query, limit, newestFirst: true });
  }
}

export type AcknowledgeAlertError = 'ALERT_NOT_FOUND' | 'ALERT_ALREADY_ACKNOWLEDGED';

/** D46: the operator acknowledges an alert (it stays in the history). Audited, with an optional note. */
export class AcknowledgeAlert {
  constructor(private readonly deps: AlertQueryDependencies) {}

  execute(operator: string, alertId: string, note?: string): Promise<Result<Alert, AcknowledgeAlertError>> {
    const { repository, clock, newId } = this.deps;
    return repository.transaction(async (tx) => {
      const alert = await tx.alerts.get(alertId);
      if (!alert) return err('ALERT_NOT_FOUND');
      if (alert.acknowledgedAt) return err('ALERT_ALREADY_ACKNOWLEDGED');
      const now = clock.now();
      if (!(await tx.alerts.acknowledge(alertId, operator, now))) return err('ALERT_ALREADY_ACKNOWLEDGED');
      const trimmed = note?.trim();
      await tx.audit.append({
        auditId: newId(),
        actor: operator,
        action: 'ALERT_ACKNOWLEDGED',
        at: now,
        subject: alertId,
        newValue: `${alert.type}: ${alert.subject}`,
        ...(trimmed ? { note: trimmed } : {}),
      });
      return ok({ ...alert, acknowledgedAt: now, acknowledgedBy: operator });
    });
  }
}
