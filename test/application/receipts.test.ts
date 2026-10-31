import { beforeEach, describe, expect, it } from 'vitest';

import { GetBatchSummary } from '../../src/application/receipts/get-batch-summary';
import { publishNextManifest } from '../../src/application/receipts/receipt-dependencies';
import { RefreshRecipients } from '../../src/application/receipts/refresh-recipients';
import { RemoveReceipt } from '../../src/application/receipts/remove-receipt';
import { ResolveDuplicateConflict } from '../../src/application/receipts/resolve-duplicate-conflict';
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

    it('discards repeated content under the same name, also within the same upload and in another batch, without counting it', async () => {
      const first = await uploadOk([altos, altos]);
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

describe('same content under different names (D31)', () => {
  let fx: ReceiptFixture;
  let upload: UploadReceipts;
  let remove: RemoveReceipt;
  let refresh: RefreshRecipients;
  let summary: GetBatchSummary;
  let resolve: ResolveDuplicateConflict;

  beforeEach(() => {
    fx = receiptFixture();
    upload = new UploadReceipts(fx.deps);
    remove = new RemoveReceipt(fx.deps);
    refresh = new RefreshRecipients(fx.deps);
    summary = new GetBatchSummary(fx.deps);
    resolve = new ResolveDuplicateConflict(fx.deps);
  });

  const content = pdfBytes('same-content');
  const forAltos = { name: fileName('Edificio Altos', 'MULTA', '104522'), content };
  const forPalmas = { name: fileName('Conjunto Las Palmas', 'MULTA', '98765'), content };
  const forAnglo = { name: fileName('Anglo Torre', 'MULTA', '7001'), content };
  const uploadOk = async (files: Parameters<UploadReceipts['execute']>[3], block: 'CASH' | 'ANGLO' = 'CASH') => {
    const result = await upload.execute(OP, OCT_2026, block, files);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const only = async () => {
    const all = [...(await fx.repository.receipts.listByBatch(OCT_2026, 'CASH')), ...(await fx.repository.receipts.listByBatch(OCT_2026, 'ANGLO'))];
    expect(all).toHaveLength(1);
    return all[0]!;
  };
  const entries = async (block: 'CASH' | 'ANGLO') => {
    const batch = await fx.repository.batches.get(OCT_2026, block);
    return batch ? ((await fx.repository.batches.getManifest(OCT_2026, block, batch.manifestVersion))?.entries ?? []) : [];
  };

  it('in the same upload, with two contracts: both are marked, nothing is ready to send, the summary shows both names', async () => {
    const result = await uploadOk([forAltos, forPalmas]);
    expect(result.results).toMatchObject([
      { fileName: forAltos.name, outcome: 'REGISTERED', state: 'PENDING', errorType: 'DUPLICATE_CONFLICT' },
      { fileName: forPalmas.name, outcome: 'DUPLICATE_CONFLICT', conflictWith: { fileName: forAltos.name, contract: '104522', conceptKey: 'MULTA', block: 'CASH' } },
    ]);
    expect(await only()).toMatchObject({ state: 'PENDING', errorType: 'DUPLICATE_CONFLICT', conflictingNames: [{ fileName: forPalmas.name, contract: '98765' }] });
    expect(await entries('CASH')).toEqual([]);
    const view = await summary.execute(OP, OCT_2026, 'CASH');
    expect(view.readyToSend).toEqual([]);
    expect(view.needsCorrection).toMatchObject([{ fileName: forAltos.name, errorType: 'DUPLICATE_CONFLICT', conflictingNames: [{ fileName: forPalmas.name, contract: '98765' }] }]);
  });

  it('even with the same contract and concept: any other name is a conflict', async () => {
    const renamed = { name: fileName('Edificio Altos oct', 'MULTA', '104522'), content };
    expect((await uploadOk([forAltos, renamed])).results.map((r) => r.outcome)).toEqual(['REGISTERED', 'DUPLICATE_CONFLICT']);
  });

  it('in a later upload of another batch (point c): the registered receipt is blocked where it is and its manifest changes', async () => {
    await uploadOk([forAltos]);
    expect(await entries('CASH')).toHaveLength(1);
    const later = await uploadOk([forAnglo], 'ANGLO');
    expect(later.results).toMatchObject([{ outcome: 'DUPLICATE_CONFLICT', conflictWith: { block: 'CASH', contract: '104522' } }]);
    expect(await only()).toMatchObject({ block: 'CASH', errorType: 'DUPLICATE_CONFLICT', conflictingNames: [{ block: 'ANGLO', contract: '7001' }] });
    expect((await fx.repository.batches.get(OCT_2026, 'CASH'))?.manifestVersion).toBe(2);
    expect(await entries('CASH')).toEqual([]);
  });

  it('the operator chooses a name of another batch: the receipt moves there, with that contract, and can be sent; audited', async () => {
    await uploadOk([forAltos]);
    await uploadOk([forAnglo], 'ANGLO');
    const sha = (await only()).sha256;
    expect(await resolve.execute(OP, sha, forAnglo.name, '')).toEqual({ ok: false, error: { code: 'NOTE_REQUIRED' } });
    expect(await resolve.execute(OP, sha, fileName('Otro', 'MULTA', '1'), 'x')).toEqual({ ok: false, error: { code: 'NAME_NOT_IN_CONFLICT' } });

    const resolved = await resolve.execute(OP, sha, forAnglo.name, 'El negocio confirmó que es de Anglo Torre');
    expect(resolved).toEqual({ ok: true, value: { sha256: sha, fileName: forAnglo.name, period: '2026-10', block: 'ANGLO', state: 'PENDING', errorType: undefined, email: 'anglo@sap.co' } });
    const receipt = await only();
    expect(receipt).toMatchObject({ block: 'ANGLO', contract: '7001', recipient: { email: 'anglo@sap.co' } });
    expect(receipt.conflictingNames).toBeUndefined();
    expect(await entries('CASH')).toEqual([]);
    expect((await entries('ANGLO')).map((e) => e.fileName)).toEqual([forAnglo.name]);
    expect(await fx.files.read({ period: OCT_2026, block: 'ANGLO', sha256: sha })).toBeDefined();
    expect(await fx.files.read({ period: OCT_2026, block: 'CASH', sha256: sha })).toBeUndefined();
    expect((await fx.repository.audit.list()).at(-1)).toMatchObject({ action: 'DUPLICATE_CONFLICT_RESOLVED', subject: sha, newValue: `${forAnglo.name} (2026-10/ANGLO)`, note: 'El negocio confirmó que es de Anglo Torre' });
    expect(await resolve.execute(OP, sha, forAnglo.name, 'otra vez')).toEqual({ ok: false, error: { code: 'RECEIPT_NOT_IN_CONFLICT' } });
  });

  it('the operator keeps the first name: it stays in its batch and is ready to send', async () => {
    await uploadOk([forAltos, forPalmas]);
    const sha = (await only()).sha256;
    expect(await resolve.execute(OP, sha, forAltos.name, 'Es de Altos')).toMatchObject({ ok: true, value: { block: 'CASH', email: 'admin@altos.com' } });
    expect((await entries('CASH')).map((e) => e.contract)).toEqual(['104522']);
  });

  it('the chosen name must still be valid (its concept may have been retired since)', async () => {
    await uploadOk([forAltos, forPalmas]);
    await fx.repository.concepts.save({ key: 'MULTA', subject: 'Multa', active: false });
    expect(await resolve.execute(OP, (await only()).sha256, forPalmas.name, 'x')).toEqual({ ok: false, error: { code: 'CHOSEN_NAME_INVALID', reason: 'UNKNOWN_CONCEPT' } });
  });

  it('removing the receipt ends the conflict; uploading it again under the right name registers it normally', async () => {
    await uploadOk([forAltos, forPalmas]);
    const sha = (await only()).sha256;
    expect((await remove.execute(OP, sha)).ok).toBe(true);
    expect((await only()).conflictingNames).toBeUndefined();
    const again = await uploadOk([forPalmas]);
    expect(again.results).toMatchObject([{ outcome: 'REGISTERED', state: 'PENDING' }]);
    expect(await only()).toMatchObject({ contract: '98765', recipient: { email: 'palmas@correo.co' } });
    expect((await entries('CASH')).map((e) => e.contract)).toEqual(['98765']);
  });

  it('refreshing the recipients keeps it blocked', async () => {
    await uploadOk([forAltos, forPalmas]);
    await refresh.execute(OP, OCT_2026, 'CASH');
    expect(await only()).toMatchObject({ errorType: 'DUPLICATE_CONFLICT' });
    expect(await entries('CASH')).toEqual([]);
  });

  it('point a: already sent, it cannot be held back; the new upload is reported and an alert raised, nothing else changes', async () => {
    await uploadOk([forAltos]);
    const sent = await only();
    await fx.repository.receipts.save({ ...sent, state: 'SENT', deliveryState: 'UNCONFIRMED', attempts: 1 });
    const later = await uploadOk([forPalmas]);
    expect(later.results).toMatchObject([{ outcome: 'DUPLICATE_CONFLICT', conflictWith: { fileName: forAltos.name, state: 'SENT' } }]);
    expect(await only()).toMatchObject({ state: 'SENT', fileName: forAltos.name });
    expect((await only()).conflictingNames).toBeUndefined();
    expect((await fx.repository.alerts.list()).map((a) => [a.type, a.subject])).toEqual([['DUPLICATE_CONFLICT', sent.sha256]]);
    expect((await fx.repository.receipts.history(sent.sha256)).map((h) => h.event)).toContain('DUPLICATE_CONFLICT');
  });

  it('point b: an invalid name is not a destination: A1 applies, no conflict', async () => {
    const invalid = { name: 'Edificio Altos CNCPT  MULTA CNTRT 104522.pdf', content };
    const result = await uploadOk([invalid, forPalmas]);
    expect(result.results.map((r) => r.outcome)).toEqual(['REGISTERED', 'REGISTERED']);
    expect(await only()).toMatchObject({ fileName: forPalmas.name, state: 'PENDING' });
    expect((await only()).conflictingNames).toBeUndefined();
    expect((await uploadOk([invalid])).results[0]?.outcome).toBe('DUPLICATE');
  });
});
