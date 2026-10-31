import type { Alert } from '../../../domain/alert/alert';
import type { AlertNotifier } from '../../../ports/alert-notifier';
import type { ProgressNotifier, ProgressListener, StoredProgressEvent } from '../../../ports/progress-notifier';

export class RecordingProgressNotifier implements ProgressNotifier {
  readonly events: StoredProgressEvent[] = [];

  private readonly listeners = new Set<{ executionId: string; listener: ProgressListener }>();

  publish(event: StoredProgressEvent): void {
    this.events.push(event);
    for (const l of this.listeners) if (l.executionId === event.executionId) l.listener(event);
  }

  subscribe(executionId: string, listener: ProgressListener): () => void {
    const entry = { executionId, listener };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }
}

export class RecordingAlertNotifier implements AlertNotifier {
  readonly alerts: Alert[] = [];

  async notify(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }
}
