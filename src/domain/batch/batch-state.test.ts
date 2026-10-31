import { describe, expect, it } from 'vitest';

import { DomainError } from '../shared/domain-error';
import { acceptsChanges, assertBatchTransition, BatchState, canExecute, canTransitionBatch } from './batch-state';

describe('batch state', () => {
  it('allows exactly the transitions of the state diagram', () => {
    const allowed = ['OPEN>OPEN', 'OPEN>RUNNING', 'RUNNING>COMPLETED', 'RUNNING>STOPPED', 'STOPPED>RUNNING', 'STOPPED>OPEN', 'COMPLETED>OPEN'];
    for (const from of Object.values(BatchState)) {
      for (const to of Object.values(BatchState)) {
        expect(canTransitionBatch(from, to), `${from} → ${to}`).toBe(allowed.includes(`${from}>${to}`));
      }
    }
    expect(() => assertBatchTransition('COMPLETED', 'RUNNING')).toThrow(DomainError);
  });

  it('refuses changes only while running', () => {
    expect(acceptsChanges('RUNNING')).toBe(false);
    expect(acceptsChanges('COMPLETED')).toBe(true);
  });

  it('executes from OPEN or STOPPED', () => {
    expect(canExecute('OPEN')).toBe(true);
    expect(canExecute('STOPPED')).toBe(true);
    expect(canExecute('COMPLETED')).toBe(false);
    expect(canExecute('RUNNING')).toBe(false);
  });
});
