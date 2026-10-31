import { DomainError } from '../shared/domain-error';

export const BatchState = {
  OPEN: 'OPEN',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  STOPPED: 'STOPPED',
} as const;
export type BatchState = (typeof BatchState)[keyof typeof BatchState];

/** Batch state machine (docs/architecture/arquitectura.md §7). A batch is created OPEN by its first upload. */
const TRANSITIONS: Readonly<Record<BatchState, readonly BatchState[]>> = {
  OPEN: ['OPEN', 'RUNNING'],
  RUNNING: ['COMPLETED', 'STOPPED'],
  STOPPED: ['RUNNING', 'OPEN'],
  COMPLETED: ['OPEN'],
};

export function canTransitionBatch(from: BatchState, to: BatchState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertBatchTransition(from: BatchState, to: BatchState): void {
  if (!canTransitionBatch(from, to)) throw new DomainError(`Batch cannot go from ${from} to ${to}`);
}

/** Upload and remove are refused while the batch runs. */
export function acceptsChanges(state: BatchState): boolean {
  return state !== 'RUNNING';
}

export function canExecute(state: BatchState): boolean {
  return state === 'OPEN' || state === 'STOPPED';
}
