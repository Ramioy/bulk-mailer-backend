import type { Block } from '../block/block';
import type { Period } from '../period/period';
import type { BatchStopReason } from '../shared/error-types';
import type { BatchState } from './batch-state';

/** Receipts of one (period, block): the unit of operation. */
export interface Batch {
  readonly period: Period;
  readonly block: Block;
  readonly state: BatchState;
  /** Current manifest version; 0 before the first upload. */
  readonly manifestVersion: number;
  readonly stopReason?: BatchStopReason;
  readonly updatedAt: Date;
}

/** One run of a batch manifest. Only one execution runs at a time in the whole system. */
export interface Execution {
  readonly executionId: string;
  readonly period: Period;
  readonly block: Block;
  readonly manifestVersion: number;
  readonly startedBy: string;
  readonly startedAt: Date;
  /** Archive copy in force for the whole execution, if enabled. */
  readonly copyAddress?: string;
  readonly finishedAt?: Date;
  readonly result?: 'COMPLETED' | 'STOPPED';
  readonly stopReason?: BatchStopReason;
}
