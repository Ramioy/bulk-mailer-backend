import type { Alert } from '../../../domain/alert/alert';
import type { AlertNotifier } from '../../../ports/alert-notifier';
import type { ProgressEvent, ProgressNotifier } from '../../../ports/progress-notifier';

export class RecordingProgressNotifier implements ProgressNotifier {
  readonly events: Array<{ executionId: string; event: ProgressEvent }> = [];

  publish(executionId: string, event: ProgressEvent): void {
    this.events.push({ executionId, event });
  }
}

export class RecordingAlertNotifier implements AlertNotifier {
  readonly alerts: Alert[] = [];

  async notify(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }
}
