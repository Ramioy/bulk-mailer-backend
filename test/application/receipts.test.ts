import { beforeEach, describe, expect, it } from 'vitest';

import { GetBatchSummary } from '../../src/application/receipts/get-batch-summary';
import { publishNextManifest } from '../../src/application/receipts/receipt-dependencies';
import { RefreshRecipients } from '../../src/application/receipts/refresh-recipients';
import { RemoveReceipt } from '../../src/application/receipts/remove-receipt';
import { UploadReceipts } from '../../src/application/receipts/upload-receipts';
import { Period } from '../../src/domain/period/period';
import type { Receipt } from '../../src/domain/receipt/receipt';
import { OCT_2026 } from '../support/builders';
import { fileName, pdfBytes, receiptFixture, type ReceiptFixture } from '../support/receipt-fixtures';

const OP = 'operador';

describe('receipt use cases', () => {
  let fx: ReceiptFixture;
  let upload: UploadReceipts;
  let remove: RemoveReceipt;
  let refresh: RefreshRecipients;
  let summary: GetBatchSummary;

  beforeEach(() => {
    fx = receiptFixture();
    upload = new UploadReceipts(fx.deps);
    remove = new RemoveReceipt(fx.deps);
    refresh = new RefreshRecipients(fx.deps);
    summary = new GetBatchSummary(fx.deps);
  });

  const altos = { name: fileName('Edificio Altos', 'MULTA', '104522'), content: pdfBytes('altos') };
  const palmas = { name: fileName('Conjunto Las Palmas', 'CUOTA EXTRA', '98765'), content: pdfBytes('palmas') };

  async function uploadOk(files: Parameters<UploadReceipts['execute']>[3], block: 'CASH' | 'ANGLO' = 'CASH', period = OCT_2026) {
    const result = await upload.execute(OP, period, block, files);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  describe('upload', () => {
    it('registers valid receipts with their recipient, stores the files and publishes manifest v1', async () => {
      const result = await uploadOk([altos, palmas]);
      expect(result.manifestVersion).toBe(1);
      expect(result.results.map((r) => [r.outcome, r.state, r.errorType])).toEqual([
        ['REGISTERED', 'PENDING', undefined],
        ['REGISTERED', 'PENDING', undefined],
      ]);
      const view = await summary.execute(OP, OCT_2026, 'CASH');
      expect(view.state).toBe('OPEN');
      expect(view.readyToSend.map((r) => [r.complexName, r.email])).toEqual([
        ['Conjunto Las Palmas', 'palmas@correo.co'],
        ['Edificio Altos', 'admin@altos.com'],
      ]);
      expect(await fx.files.read({ period: OCT_2026, block: 'CASH', sha256: result.results[0]?.sha256 as never })).toEqual(altos.content);
    });

    it('marks file and name problems INVALID without keeping the file', async () => {
      const result = await uploadOk([
        { name: 'Conjunto Las Palmas MULTA 98765.pdf', content: pdfBytes('a') },
        { name: fileName('X', 'Multa', '98765'), content: pdfBytes('b') },
        { name: fileName('X', 'MULTA', '98765'), content: new Uint8Array(Buffer.from('PK zip')) },
        { name: fileName('Y', 'MULTA', '98765'), content: new Uint8Array(Buffer.from('%PDF-1.7\n<< /JavaScript (x) >>\n%%EOF')) },
      ]);
      expect(result.results.map((r) => [r.state, r.errorType])).toEqual([
        ['INVALID', 'INVALID_NAME'],
        ['INVALID', 'UNKNOWN_CONCEPT'],
        ['INVALID', 'NOT_A_PDF'],
        ['INVALID', 'PDF_ACTIVE_CONTENT'],
      ]);
      for (const r of result.results) {
        expect(await fx.files.read({ period: OCT_2026, block: 'CASH', sha256: r.sha256 as never })).toBeUndefined();
      }
      const view = await summary.execute(OP, OCT_2026, 'CASH');
      expect(view.readyToSend).toEqual([]);
      expect(view.needsCorrection).toHaveLength(4);
    });

    it('keeps receipts without a resolved recipient PENDING but out of the manifest', async () => {
      fx.tayrona.setUnavailable(true);
      const result = await uploadOk([altos, { name: fileName('Z', 'MULTA', '55555'), content: pdfBytes('z') }]);
      expect(result.results.map((r) => [r.state, r.errorType])).toEqual([
        ['PENDING', 'SOURCE_UNAVAILABLE'],
        ['PENDING', 'SOURCE_UNAVAILABLE'],
      ]);
      const view = await summary.execute(OP, OCT_2026, 'CASH');
      expect(view.readyToSend).toEqual([]);
      expect(view.needsCorrection.map((r) => r.errorType)).toEqual(['SOURCE_UNAVAILABLE', 'SOURCE_UNAVAILABLE']);
    });

    it('maps inactive contracts', async () => {
      const result = await uploadOk([{ name: fileName('Z', 'MULTA', '55555'), content: pdfBytes('z') }]);
      expect(result.results[0]).toMatchObject({ state: 'PENDING', errorType: 'CONTRACT_INACTIVE' });
    });

    it('resolves the ANGLO block against SAP', async () => {
      const result = await uploadOk([{ name: fileName('Anglo', 'MULTA', '7001'), content: pdfBytes('anglo') }], 'ANGLO');
      expect(result.results[0]).toMatchObject({ state: 'PENDING', errorType: undefined });
      expect(fx.sap.queries).toEqual(['7001']);
      expect(fx.tayrona.queries).toEqual([]);
    });

    it('queries the source once per contract', async () => {
      await uploadOk([altos, { name: fileName('Edificio Altos', 'CUOTA EXTRA', '104522'), content: pdfBytes('altos-2') }]);
      expect(fx.tayrona.queries).toEqual(['104522']);
    });

    it('flags suppressed addresses', async () => {
      await fx.repository.suppressions.save({ email: 'admin@altos.com', reason: 'HARD_BOUNCE', since: fx.clock.now() });
      expect((await uploadOk([altos])).results[0]).toMatchObject({ state: 'PENDING', errorType: 'EMAIL_SUPPRESSED' });
    });

    it('discards repeated content, also within the same upload, without counting it', async () => {
      const first = await uploadOk([altos, { ...altos, name: fileName('Copia', 'MULTA', '104522') }]);
      expect(first.results.map((r) => r.outcome)).toEqual(['REGISTERED', 'DUPLICATE']);

      const again = await uploadOk([altos]);
      expect(again.results[0]).toMatchObject({ outcome: 'DUPLICATE', duplicateOf: { period: '2026-10', block: 'CASH', state: 'PENDING' } });
      expect(again.manifestVersion).toBe(1);

      const elsewhere = await uploadOk([altos], 'ANGLO');
      expect(elsewhere.results[0]?.outcome).toBe('DUPLICATE');
    });

    it('re-evaluates an INVALID receipt uploaded again with a corrected name (same hash, one record)', async () => {
      const bad = { name: 'Edificio Altos MULTA 104522.pdf', content: altos.content };
      const first = await uploadOk([bad]);
      const second = await uploadOk([altos]);
      expect(second.results[0]).toMatchObject({ outcome: 'REGISTERED', state: 'PENDING', sha256: first.results[0]?.sha256 });
      const history = await fx.repository.receipts.history(first.results[0]?.sha256 as never);
      expect(history.map((h) => h.event)).toEqual(['UPLOADED', 'UPLOADED_AGAIN']);
    });

    it('moves a receipt removed from another block (D8)', async () => {
      const sha256 = (await uploadOk([altos])).results[0]?.sha256 as never;
      expect((await remove.execute(OP, sha256)).ok).toBe(true);
      const moved = await uploadOk([altos], 'ANGLO');
      expect(moved.results[0]).toMatchObject({ outcome: 'REGISTERED', sha256 });
      expect(await fx.repository.receipts.get(sha256)).toMatchObject({ block: 'ANGLO' });
      expect((await fx.repository.receipts.history(sha256)).at(-1)).toMatchObject({ event: 'MOVED', detail: 'from 2026-10/CASH' });
    });

    it('rejects files above the size limit without registering them', async () => {
      const result = await uploadOk([{ ...altos, tooLarge: true }]);
      expect(result.results[0]).toMatchObject({ outcome: 'REJECTED', errorType: 'ATTACHMENT_TOO_LARGE' });
      expect(result.manifestVersion).toBe(0);
    });

    it('gives a purged FAILED receipt its file back, keeping it FAILED', async () => {
      const sha256 = (await uploadOk([altos])).results[0]?.sha256 as never;
      const receipt = await fx.repository.receipts.get(sha256);
      await fx.repository.receipts.save({ ...(receipt as Receipt), state: 'FAILED', errorType: 'PROVIDER_REJECTED', fileAvailable: false });
      await fx.files.purgeBatch(OCT_2026, 'CASH');
      await fx.repository.transaction((tx) => publishNextManifest(tx, OCT_2026, 'CASH', fx.clock.now()));

      const view = await summary.execute(OP, OCT_2026, 'CASH');
      expect(view.needsCorrection[0]).toMatchObject({ state: 'FAILED', errorType: 'FILE_NOT_AVAILABLE' });

      const result = await uploadOk([altos]);
      expect(result.results[0]).toMatchObject({ outcome: 'REGISTERED', state: 'FAILED' });
      expect(await fx.files.read({ period: OCT_2026, block: 'CASH', sha256 })).toEqual(altos.content);
      expect((await summary.execute(OP, OCT_2026, 'CASH')).readyToSend).toHaveLength(1);
    });

    it('audits every upload with the new manifest version', async () => {
      await uploadOk([altos]);
      expect((await fx.repository.audit.list()).at(-1)).toMatchObject({
        action: 'RECEIPTS_UPLOADED',
        actor: OP,
        subject: '2026-10/CASH',
        newValue: 'manifest v1',
      });
    });
  });

  describe('refusals', () => {
    it('refuses periods other than the current and the previous one', async () => {
      expect(await upload.execute(OP, Period.of(2026, 8), 'CASH', [altos])).toEqual({ ok: false, error: 'PERIOD_NOT_OPERABLE' });
      expect((await upload.execute(OP, Period.of(2026, 9), 'CASH', [altos])).ok).toBe(true);
    });

    it('refuses changes while an execution runs anywhere', async () => {
      await fx.repository.executions.tryStart({
        executionId: 'e1',
        period: OCT_2026,
        block: 'ANGLO',
        manifestVersion: 1,
        startedBy: OP,
        startedAt: fx.clock.now(),
      });
      expect(await upload.execute(OP, OCT_2026, 'CASH', [altos])).toEqual({ ok: false, error: 'EXECUTION_IN_PROGRESS' });
    });

    it('serialises concurrent uploads: every manifest version is unique', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          upload.execute(OP, OCT_2026, 'CASH', [{ name: fileName(`E${i}`, 'MULTA', '104522'), content: pdfBytes(`c${i}`) }]),
        ),
      );
      expect(results.map((r) => (r.ok ? r.value.manifestVersion : 0)).sort()).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('remove', () => {
    it('removes an unsent receipt, deletes its file and publishes a new manifest', async () => {
      const sha256 = (await uploadOk([altos, palmas])).results[0]?.sha256 as never;
      expect(await remove.execute(OP, sha256)).toEqual({ ok: true, value: { manifestVersion: 2 } });
      expect(await fx.files.read({ period: OCT_2026, block: 'CASH', sha256 })).toBeUndefined();
      const view = await summary.execute(OP, OCT_2026, 'CASH');
      expect(view.readyToSend).toHaveLength(1);
      expect(view.removed).toHaveLength(1);
    });

    it('never removes a SENT or UNCERTAIN receipt', async () => {
      const sha256 = (await uploadOk([altos])).results[0]?.sha256 as never;
      const receipt = await fx.repository.receipts.get(sha256);
      for (const state of ['SENT', 'UNCERTAIN'] as const) {
        await fx.repository.receipts.save({ ...(receipt as Receipt), state });
        expect(await remove.execute(OP, sha256)).toEqual({ ok: false, error: 'RECEIPT_NOT_REMOVABLE' });
      }
      expect(await remove.execute(OP, 'f'.repeat(64) as never)).toEqual({ ok: false, error: 'RECEIPT_NOT_FOUND' });
    });
  });

  describe('refresh recipients', () => {
    it('re-queries the source; a changed email produces a new manifest version', async () => {
      await uploadOk([altos]);
      fx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'nuevo@altos.com' });
      expect(await refresh.execute(OP, OCT_2026, 'CASH')).toEqual({ ok: true, value: { manifestVersion: 2, refreshed: 1 } });
      expect((await summary.execute(OP, OCT_2026, 'CASH')).readyToSend[0]?.email).toBe('nuevo@altos.com');
    });

    it('resolves receipts that had the source unavailable', async () => {
      fx.tayrona.setUnavailable(true);
      await uploadOk([altos]);
      fx.tayrona.setUnavailable(false);
      await refresh.execute(OP, OCT_2026, 'CASH');
      expect((await summary.execute(OP, OCT_2026, 'CASH')).readyToSend).toHaveLength(1);
    });
  });

  describe('summary', () => {
    it('is empty before the first upload and audits the review with the manifest version afterwards', async () => {
      expect(await summary.execute(OP, OCT_2026, 'CASH')).toMatchObject({ state: undefined, manifestVersion: 0, archiveCopyEnabled: false });
      expect(await fx.repository.audit.list()).toEqual([]);

      await uploadOk([altos]);
      await summary.execute(OP, OCT_2026, 'CASH');
      expect((await fx.repository.audit.list()).at(-1)).toMatchObject({ action: 'BATCH_REVIEWED', newValue: 'manifest v1' });
    });
  });
});
