import type { ReceiptState } from '../../domain/receipt/receipt-state';
import type { ReceiptErrorType } from '../../domain/shared/error-types';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';
import type { Clock } from '../../ports/clock';
import type { ProgressCounters, ProgressEvent, ProgressNotifier, StoredProgressEvent } from '../../ports/progress-notifier';

/** Stores every progress event (so a new session can catch up) and then pushes it live. */
export class ProgressRecorder {
  constructor(
    private readonly repository: Pick<BulkMailerStores, 'executionEvents'>,
    private readonly notifier: ProgressNotifier,
    private readonly clock: Clock,
  ) {}

  async emit(executionId: string, event: ProgressEvent): Promise<StoredProgressEvent> {
    const stored = await this.repository.executionEvents.append(executionId, this.clock.now(), event);
    this.notifier.publish(stored);
    return stored;
  }
}

export class Counters {
  private processed = 0;
  private readonly byState: Partial<Record<ReceiptState, number>> = {};
  private readonly byErrorType: Partial<Record<ReceiptErrorType, number>> = {};

  constructor(private readonly total: number) {}

  record(state: ReceiptState, errorType?: ReceiptErrorType): void {
    this.processed += 1;
    this.byState[state] = (this.byState[state] ?? 0) + 1;
    if (errorType) this.byErrorType[errorType] = (this.byErrorType[errorType] ?? 0) + 1;
  }

  snapshot(): ProgressCounters {
    return { total: this.total, processed: this.processed, byState: { ...this.byState }, byErrorType: { ...this.byErrorType } };
  }
}
