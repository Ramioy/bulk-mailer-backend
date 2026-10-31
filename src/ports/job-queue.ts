export const JobType = {
  EXECUTE_BATCH: 'EXECUTE_BATCH',
  RECONCILE_ATTEMPT: 'RECONCILE_ATTEMPT',
  SWEEP_UNCONFIRMED: 'SWEEP_UNCONFIRMED',
  PROCESS_DELIVERY_EVENT: 'PROCESS_DELIVERY_EVENT',
  /** Every minute while a batch runs and shortly after (D21). */
  CHECK_RECENT_SENDS: 'CHECK_RECENT_SENDS',
  /** D41: deletes the file of a receipt once nothing needs it any more (queued in the transaction that decided it). */
  DELETE_RECEIPT_FILE: 'DELETE_RECEIPT_FILE',
  /** D41: deletes the files of a processed batch that are no longer needed (explicit list, D42). */
  PURGE_BATCH_FILES: 'PURGE_BATCH_FILES',
  /** D41: periodic; deletes files no receipt needs (left behind by a crash or a failed deletion). */
  PURGE_ORPHAN_FILES: 'PURGE_ORPHAN_FILES',
  /** D50: daily; deletes finished jobs and dispatched outbox events older than WORK_RETENTION_DAYS. */
  PURGE_FINISHED_WORK: 'PURGE_FINISHED_WORK',
} as const;
export type JobType = (typeof JobType)[keyof typeof JobType];

export interface NewJob {
  readonly type: JobType;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Not claimable before this instant. Default: now. */
  readonly runAt?: Date;
}

export interface Job extends NewJob {
  readonly jobId: string;
  readonly runAt: Date;
  readonly attempts: number;
}

/**
 * Background work with recovery after crashes. A claimed job that is neither completed nor failed
 * becomes claimable again after a restart. Jobs are not retried automatically after `fail`.
 */
export interface JobQueue {
  enqueue(job: NewJob): Promise<string>;
  /** Claims the oldest due job (of these types, when given), or `undefined` when none is due. */
  claimNext(now: Date, types?: readonly JobType[]): Promise<Job | undefined>;
  complete(jobId: string): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
  /** A job of this type is waiting or running (READY or CLAIMED): periodic work is not queued twice (D38). */
  hasPending(type: JobType): Promise<boolean>;
  /** D50: deletes DONE and FAILED jobs last updated before `before`; returns how many. Pending jobs are never touched. */
  purgeFinished(before: Date): Promise<number>;
  /** Called at startup: releases jobs claimed by a process that died. */
  releaseAbandoned(): Promise<number>;
}
