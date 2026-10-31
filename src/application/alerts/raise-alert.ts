import type { Alert } from '../../domain/alert/alert';
import type { AlertNotifier } from '../../ports/alert-notifier';
import type { AlertStore } from '../../ports/bulk-mailer-repository';

/** Every alert is persisted first; delivery to the registered providers never blocks the operation. */
export async function raiseAlert(alerts: AlertStore, notifiers: readonly AlertNotifier[], alert: Alert): Promise<void> {
  await alerts.insert(alert);
  await Promise.allSettled(notifiers.map((n) => n.notify(alert)));
}
