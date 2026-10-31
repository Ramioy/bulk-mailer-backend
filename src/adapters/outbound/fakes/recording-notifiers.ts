import type { Alert } from '../../../domain/alert/alert';
import type { AlertNotifier } from '../../../ports/alert-notifier';
import type { ProgressNotifier, StoredProgressEvent } from '../../../ports/progress-notifier';

export class RecordingProgressNotifier implements ProgressNotifier {
  readonly events: StoredProgressEvent[] = [];

  publish(event: StoredProgressEvent): void {
    this.events.push(event);
  }
}

export class RecordingAlertNotifier implements AlertNotifier {
  readonly alerts: Alert[] = [];

  async notify(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }
}
