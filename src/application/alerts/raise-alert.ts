import type { Alert } from '../../domain/alert/alert';
import type { Receipt } from '../../domain/receipt/receipt';
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

/** M1: a rejection with a code we do not know is reported, so the code can be reviewed and classified. */
export async function unknownRejectionAlert(tx: Pick<BulkMailerStores, 'alerts' | 'outbox'>, newId: () => string, now: Date, receipt: Receipt, detail: string): Promise<void> {
  await raiseAlert(tx, newId, {
    alertId: newId(),
    type: 'PROVIDER_UNKNOWN_ERROR',
    subject: receipt.sha256,
    detail: `${receipt.fileName}: ${detail}`,
    raisedAt: now,
  });
}
