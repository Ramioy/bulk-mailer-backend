import type { Alert } from '../../domain/alert/alert';
import type { AlertNotifier } from '../../ports/alert-notifier';

/**
 * First registered alert provider: the interface. Alerts are persisted before any provider is called and the
 * interface reads them from `GET /alerts`, so this provider has nothing else to do.
 */
export class UiAlertNotifier implements AlertNotifier {
  async notify(_alert: Alert): Promise<void> {}
}
