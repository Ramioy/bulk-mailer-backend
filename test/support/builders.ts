import type { Execution } from '../../src/domain/batch/batch';
import { Period } from '../../src/domain/period/period';
import type { Receipt } from '../../src/domain/receipt/receipt';
import { toSha256, type Sha256 } from '../../src/domain/receipt/sha256';
import type { Attempt } from '../../src/domain/sending/attempt';

export const OCT_2026 = Period.of(2026, 10);
export const T0 = new Date('2026-10-15T15:00:00.000Z');

/** Deterministic hash from a short seed: `hashOf('a')` = 'aaaa…'. */
export const hashOf = (seed: string): Sha256 => toSha256(seed.repeat(64).slice(0, 64));

export function aReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    sha256: hashOf('a'),
    period: OCT_2026,
    block: 'CASH',
    state: 'PENDING',
    fileName: 'Edificio Altos CNCPT MULTA CNTRT 104522.pdf',
    conceptKey: 'MULTA',
    contract: '104522',
    sizeBytes: 1024,
    recipient: { email: 'admin@altos.com', complexName: 'Edificio Altos' },
    fileAvailable: true,
    attempts: 0,
    createdAt: T0,
    updatedAt: T0,
    version: 1,
    ...overrides,
  };
}

export function anExecution(overrides: Partial<Execution> = {}): Execution {
  return {
    executionId: 'exec-1',
    period: OCT_2026,
    block: 'CASH',
    manifestVersion: 1,
    startedBy: 'operator',
    startedAt: T0,
    ...overrides,
  };
}

export function anAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    attemptId: 'attempt-1',
    sha256: hashOf('a'),
    executionId: 'exec-1',
    kind: 'BATCH',
    to: 'admin@altos.com',
    startedAt: T0,
    ...overrides,
  };
}
