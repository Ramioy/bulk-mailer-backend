import type { Alert } from '../../domain/alert/alert';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';
import { domainEvent } from '../events/domain-events';

/**
 * Persists the alert and, in the same transaction, the ALERT_RAISED event. The registered alert providers
 * receive it from the event bus after commit, so a failing provider never blocks the operation.
 */
export async function raiseAlert(stores: Pick<BulkMailerStores, 'alerts' | 'outbox'>, newId: () => string, alert: Alert): Promise<void> {
  await stores.alerts.insert(alert);
  await stores.outbox.add(domainEvent(newId, 'ALERT_RAISED', alert.raisedAt, { alert: { ...alert, raisedAt: alert.raisedAt.toISOString() } }));
}

/** Rebuilds the alert carried by an ALERT_RAISED event. */
export function alertFromEvent(payload: Readonly<Record<string, unknown>>): Alert {
  const raw = payload.alert as Omit<Alert, 'raisedAt'> & { raisedAt: string };
  return { ...raw, raisedAt: new Date(raw.raisedAt) };
}
