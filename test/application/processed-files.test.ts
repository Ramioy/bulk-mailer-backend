import { describe, expect, it } from 'vitest';

import { GetBatchSummary } from '../../src/application/receipts/get-batch-summary';
import { RefreshRecipients } from '../../src/application/receipts/refresh-recipients';
import { OCT_2026 } from '../support/builders';
import { deliveryFixture, type DeliveryFixture } from '../support/delivery-fixtures';
import { fileName, pdfBytes } from '../support/receipt-fixtures';

const byName = async (fx: DeliveryFixture) => new Map((await fx.repository.receipts.listByBatch(OCT_2026, 'CASH')).map((r) => [r.fileName, r]));
const summary = (fx: DeliveryFixture) => new GetBatchSummary(fx.deps).execute('operador', OCT_2026, 'CASH');

describe('D42: completing a batch deletes only the files of the receipts it processed', () => {
  it('a PENDING receipt with a recipient error and a receipt in conflict keep their files; a later refresh makes the first ready without uploading again', async () => {
    const fx = deliveryFixture();
    const sent = fileName('Edificio Altos', 'MULTA', '104522');
    const unknownContract = fileName('Sin Contrato', 'MULTA', '424242');
    const conflictA = fileName('Conflicto A', 'MULTA', '104522');
    const conflictB = fileName('Conflicto B', 'MULTA', '98765');
    const upload = await fx.upload.execute('operador', OCT_2026, 'CASH', [
      { name: sent, content: pdfBytes('sent') },
      { name: unknownContract, content: pdfBytes('unknown') },
      { name: conflictA, content: pdfBytes('conflict') },
      { name: conflictB, content: pdfBytes('conflict') },
    ]);
    expect(upload.ok).toBe(true);
    await fx.startAndRun();

    const receipts = await byName(fx);
    expect(await fx.repository.batches.get(OCT_2026, 'CASH')).toMatchObject({ state: 'COMPLETED' });
    expect(receipts.get(sent)).toMatchObject({ state: 'SENT', fileAvailable: false });
    expect(receipts.get(unknownContract)).toMatchObject({ state: 'PENDING', errorType: 'CONTRACT_NOT_FOUND', fileAvailable: true });
    expect(receipts.get(conflictA)).toMatchObject({ state: 'PENDING', errorType: 'DUPLICATE_CONFLICT', fileAvailable: true });
    const onVolume = new Set((await fx.files.list()).map((f) => f.sha256));
    expect(onVolume.has(receipts.get(sent)?.sha256 as never)).toBe(false);
    expect(onVolume.has(receipts.get(unknownContract)?.sha256 as never)).toBe(true);
    expect(onVolume.has(receipts.get(conflictA)?.sha256 as never)).toBe(true);
    // The orphan sweep agrees: those files are still needed.
    fx.clock.advance(2 * 3_600_000);
    expect(await fx.fileJobs.purgeOrphans.execute()).toMatchObject({ deleted: 0 });

    // The contract appears in Tayrona: refresh, and it is ready without uploading again.
    fx.tayrona.setContract('424242', { complexName: 'Nuevo Conjunto', email: 'nuevo@conjunto.co' });
    expect(await new RefreshRecipients(fx.deps).execute('operador', OCT_2026, 'CASH')).toMatchObject({ ok: true, value: { withoutFile: 0 } });
    expect((await summary(fx)).readyToSend.map((r) => r.fileName)).toEqual([unknownContract]);
    await fx.startAndRun();
    expect(fx.email.calls.map((c) => c.attachment.name)).toEqual([sent, unknownContract]);
  });

  it('the summary shows the original error next to the missing file: a FAILED / NOT_FOUND_AT_PROVIDER whose file was purged', async () => {
    const fx = deliveryFixture();
    fx.email.respondWith({ kind: 'UNCERTAIN', detail: 'timeout' });
    const { attempt } = await fx.sendOne();
    fx.clock.advance(3_600_000);
    await fx.reconcile.execute(attempt.attemptId, true);
    const [view] = (await summary(fx)).needsCorrection;
    expect(view).toMatchObject({ state: 'FAILED', errorType: 'NOT_FOUND_AT_PROVIDER', fileAvailable: false, fileError: 'FILE_NOT_AVAILABLE' });
  });

  it('a refresh tells how many receipts now have a recipient but no file', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(1);
    fx.tayrona.setUnavailable(true);
    await fx.startAndRun();
    expect((await fx.repository.receipts.listByBatch(OCT_2026, 'CASH'))[0]).toMatchObject({ state: 'FAILED', errorType: 'SOURCE_UNAVAILABLE', fileAvailable: false });

    fx.tayrona.setUnavailable(false);
    expect(await new RefreshRecipients(fx.deps).execute('operador', OCT_2026, 'CASH')).toMatchObject({ ok: true, value: { refreshed: 1, withoutFile: 1 } });
    const view = await summary(fx);
    expect(view.readyToSend).toEqual([]);
    expect(view.needsCorrection[0]).toMatchObject({ state: 'FAILED', errorType: undefined, email: 'admin@altos.com', fileError: 'FILE_NOT_AVAILABLE' });
  });
});
