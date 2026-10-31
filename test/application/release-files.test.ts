import { describe, expect, it } from 'vitest';

import { ReleaseBatchFiles } from '../../src/application/files/release-batch-files';
import { GetBatchSummary } from '../../src/application/receipts/get-batch-summary';
import type { Receipt } from '../../src/domain/receipt/receipt';
import { OCT_2026 } from '../support/builders';
import { executionFixture, type ExecutionFixture } from '../support/execution-fixtures';
import { fileName, pdfBytes } from '../support/receipt-fixtures';

const ready = fileName('Edificio Altos', 'MULTA', '104522');
const unknownContract = fileName('Sin Contrato', 'MULTA', '424242');
const conflictA = fileName('Conflicto A', 'MULTA', '104522');
const conflictB = fileName('Conflicto B', 'MULTA', '98765');

const byName = async (fx: ExecutionFixture) => new Map((await fx.repository.receipts.listByBatch(OCT_2026, 'CASH')).map((r) => [r.fileName, r]));
const summary = (fx: ExecutionFixture) => new GetBatchSummary(fx.deps).execute('operador', OCT_2026, 'CASH');
const release = (fx: ExecutionFixture, note = 'kept since October; not needed any more') => new ReleaseBatchFiles(fx.deps).execute('operador', OCT_2026, 'CASH', note);

async function batchWithNeededFiles(): Promise<ExecutionFixture> {
  const fx = executionFixture();
  const upload = await fx.upload.execute('operador', OCT_2026, 'CASH', [
    { name: ready, content: pdfBytes('ready') },
    { name: unknownContract, content: pdfBytes('unknown') },
    { name: conflictA, content: pdfBytes('conflict') },
    { name: conflictB, content: pdfBytes('conflict') },
  ]);
  expect(upload.ok).toBe(true);
  return fx;
}

describe('D51: the operator releases the files of a batch, keeping its records', () => {
  it('releases every available file, keeps states, errors and conflicts, and deletes the files by job', async () => {
    const fx = await batchWithNeededFiles();
    const before = await byName(fx);
    const versionBefore = (await fx.repository.batches.get(OCT_2026, 'CASH'))?.manifestVersion ?? 0;

    const result = await release(fx);
    expect(result).toEqual({ ok: true, value: { released: 3, manifestVersion: versionBefore + 1 } });

    const after = await byName(fx);
    for (const name of [ready, unknownContract, conflictA]) {
      const { fileAvailable: _was, updatedAt: _u, version: _v, ...kept } = before.get(name) as Receipt;
      expect(after.get(name)).toMatchObject({ ...kept, fileAvailable: false });
    }
    expect(after.get(unknownContract)).toMatchObject({ state: 'PENDING', errorType: 'CONTRACT_NOT_FOUND' });
    expect(after.get(conflictA)).toMatchObject({ state: 'PENDING', errorType: 'DUPLICATE_CONFLICT', conflictingNames: [expect.objectContaining({ fileName: conflictB })] });
    expect((await fx.repository.receipts.history(after.get(ready)?.sha256 as never)).at(-1)).toMatchObject({ event: 'FILE_RELEASED', detail: 'by operador' });

    // Deleted after the commit, by the file lane (D41).
    expect((await fx.files.list()).length).toBe(3);
    expect(await fx.runFileJobs()).toBe(3);
    expect(await fx.files.list()).toEqual([]);

    const view = await summary(fx);
    expect(view.manifestVersion).toBe(versionBefore + 1);
    expect(view.readyToSend).toEqual([]);
    expect(view.needsCorrection.map((r) => [r.fileName, r.fileError])).toEqual(
      expect.arrayContaining([
        [ready, 'FILE_NOT_AVAILABLE'],
        [unknownContract, 'FILE_NOT_AVAILABLE'],
        [conflictA, 'FILE_NOT_AVAILABLE'],
      ]),
    );
    expect(await fx.repository.batches.getManifest(OCT_2026, 'CASH', versionBefore + 1)).toMatchObject({ entries: [] });
  });

  it('D55: releasing the files of a COMPLETED batch keeps it COMPLETED (a new manifest version, no reopening)', async () => {
    const fx = await batchWithNeededFiles();
    await fx.startAndRun();
    const before = await fx.repository.batches.get(OCT_2026, 'CASH');
    expect(before).toMatchObject({ state: 'COMPLETED' });

    const result = await release(fx);
    expect(result).toMatchObject({ ok: true, value: { manifestVersion: (before?.manifestVersion ?? 0) + 1 } });
    expect(await fx.repository.batches.get(OCT_2026, 'CASH')).toMatchObject({ state: 'COMPLETED', manifestVersion: (before?.manifestVersion ?? 0) + 1 });
    expect((await summary(fx)).state).toBe('COMPLETED');
  });

  it('keeps an OPEN batch OPEN', async () => {
    const fx = await batchWithNeededFiles();
    await release(fx);
    expect(await fx.repository.batches.get(OCT_2026, 'CASH')).toMatchObject({ state: 'OPEN' });
  });

  it('audits it with the note and publishes BATCH_FILES_RELEASED', async () => {
    const fx = await batchWithNeededFiles();
    await release(fx, '  retention reviewed  ');
    expect((await fx.repository.audit.list()).at(-1)).toMatchObject({
      actor: 'operador',
      action: 'BATCH_FILES_RELEASED',
      subject: '2026-10/CASH',
      newValue: '3',
      note: 'retention reviewed',
    });
    const event = (await fx.repository.outbox.lockPending(100)).map((p) => p.event).find((e) => e.type === 'BATCH_FILES_RELEASED');
    expect(event?.payload).toMatchObject({ period: '2026-10', block: 'CASH', released: 3, by: 'operador' });
  });

  it('a later upload of the same file gives it back (A2): the receipt is ready again, the conflict still waits for the operator', async () => {
    const fx = await batchWithNeededFiles();
    await release(fx);
    await fx.runFileJobs();
    const again = await fx.upload.execute('operador', OCT_2026, 'CASH', [
      { name: ready, content: pdfBytes('ready') },
      { name: conflictA, content: pdfBytes('conflict') },
    ]);
    expect(again.ok).toBe(true);
    const after = await byName(fx);
    expect(after.get(ready)).toMatchObject({ state: 'PENDING', fileAvailable: true, errorType: undefined });
    expect(after.get(conflictA)).toMatchObject({ state: 'PENDING', fileAvailable: true, errorType: 'DUPLICATE_CONFLICT' });
    expect((await summary(fx)).readyToSend.map((r) => r.fileName)).toEqual([ready]);
    expect((await fx.files.list()).length).toBe(2);
  });

  it('keeps the file of a receipt being sent and of receipts already without file', async () => {
    const fx = await batchWithNeededFiles();
    const sending = (await byName(fx)).get(ready) as Receipt;
    await fx.repository.receipts.save({ ...sending, state: 'SENDING' });
    expect(await release(fx)).toMatchObject({ ok: true, value: { released: 2 } });
    expect((await byName(fx)).get(ready)).toMatchObject({ state: 'SENDING', fileAvailable: true });
    // Nothing left to release: a second call releases nothing and still answers.
    expect(await release(fx)).toMatchObject({ ok: true, value: { released: 0 } });
  });

  it('is a correction: allowed in a period that can no longer be operated (D50, B3)', async () => {
    const fx = await batchWithNeededFiles();
    fx.clock.set('2027-03-10T15:00:00Z');
    expect(await release(fx)).toMatchObject({ ok: true, value: { released: 3 } });
  });

  it('is refused while an execution runs, without a note, and for an unknown batch', async () => {
    const fx = await batchWithNeededFiles();
    expect(await release(fx, '   ')).toEqual({ ok: false, error: 'NOTE_REQUIRED' });
    expect(await new ReleaseBatchFiles(fx.deps).execute('operador', OCT_2026, 'ANGLO', 'note')).toEqual({ ok: false, error: 'BATCH_NOT_FOUND' });

    const batch = await fx.repository.batches.get(OCT_2026, 'CASH');
    expect((await fx.start.execute('operador', OCT_2026, 'CASH', batch?.manifestVersion ?? 0)).ok).toBe(true);
    expect(await release(fx)).toEqual({ ok: false, error: 'EXECUTION_IN_PROGRESS' });
    expect([...(await byName(fx)).values()].filter((r) => r.fileAvailable)).toHaveLength(3);
  });
});
