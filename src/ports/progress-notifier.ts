import type { BatchState } from '../domain/batch/batch-state';
import type { ReceiptState } from '../domain/receipt/receipt-state';
import type { Sha256 } from '../domain/receipt/sha256';
import type { BatchStopReason, ReceiptErrorType } from '../domain/shared/error-types';

export interface ProgressCounters {
  readonly total: number;
  readonly processed: number;
  readonly byState: Readonly<Partial<Record<ReceiptState, number>>>;
  readonly byErrorType: Readonly<Partial<Record<ReceiptErrorType, number>>>;
}

export type ProgressEvent =
  /** First event of an execution: how many receipts it will process. */
  | { readonly type: 'STARTED'; readonly counters: ProgressCounters }
  | {
      readonly type: 'RECEIPT_PROCESSED';
      readonly sha256: Sha256;
      readonly fileName: string;
      readonly state: ReceiptState;
      readonly errorType?: ReceiptErrorType;
      readonly counters: ProgressCounters;
    }
  /** Emitted before the wait starts, so the operator knows the batch is waiting, not stuck. */
  | {
      readonly type: 'WAITING';
      readonly reason: string;
      readonly seconds: number;
      readonly consecutiveIncidents: number;
      readonly nextSendAt: string;
    }
  | {
      readonly type: 'FINISHED';
      readonly batchState: Extract<BatchState, 'COMPLETED' | 'STOPPED'>;
      readonly stopReason?: BatchStopReason;
      readonly counters: ProgressCounters;
    };

/** A progress event as stored: `seq` is its position, used as SSE `id` to resume (`Last-Event-ID`). */
export interface StoredProgressEvent {
  readonly seq: number;
  readonly executionId: string;
  readonly at: Date;
  readonly event: ProgressEvent;
}

export type ProgressListener = (event: StoredProgressEvent) => void;

/** Pushes already stored events to whoever is watching live (SSE). Never throws. */
export interface ProgressNotifier {
  publish(event: StoredProgressEvent): void;
  /** D50 (B4): watch one execution's events as they are published; returns the unsubscribe function. */
  subscribe(executionId: string, listener: ProgressListener): () => void;
}
