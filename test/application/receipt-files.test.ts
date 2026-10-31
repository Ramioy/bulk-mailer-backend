import { describe, expect, it, vi } from 'vitest';

import type { SendOutcome } from '../../src/domain/sending/send-outcome';
import { OCT_2026 } from '../support/builders';
import { deliveryFixture, type DeliveryFixture } from '../support/delivery-fixtures';
import { fileName, pdfBytes } from '../support/receipt-fixtures';

const UNCERTAIN: SendOutcome = { kind: 'UNCERTAIN', detail: 'timeout' };
const MINUTE = 60_000;
const receipts = (fx: DeliveryFixture) => fx.repository.receipts.listByBatch(OCT_2026, 'CASH');
const stored = async (fx: DeliveryFixture) => (await fx.files.list()).map((f) => f.sha256).sort();
const pendingFileJobs = async (fx: DeliveryFixture) => {
  const jobs = [];
  for (const type of ['DELETE_RECEIPT_FILE', 'PURGE_BATCH_FILES'] as const) if (await fx.jobs.hasPending(type)) jobs.push(type);
  return jobs;
};

/** Starts the execution and runs it, without running the file jobs it queues. */
async function startAndRunOnly(fx: DeliveryFixture) {
  const batch = await fx.repository.batches.get(OCT_2026, 'CASH');
  const started = await fx.start.execute('operador', OCT_2026, 'CASH', batch?.manifestVersion ?? 0);
  if (!started.ok) throw new Error(started.error.code);
  const job = await fx.jobs.claimNext(fx.clock.now(), ['EXECUTE_BATCH']);
  await fx.run.execute(String(job?.payload.executionId));
  await fx.jobs.complete(job?.jobId as string);
  return started.value.executionId;
}

describe('D41: a SENT receipt no longer keeps its file', () => {
  it('a send accepted by the provider: file unavailable and its deletion queued in the same transaction, deleted by the job', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(2);
    await startAndRunOnly(fx);
    expect((await receipts(fx)).map((r) => [r.state, r.fileAvailable])).toEqual([
      ['SENT', false],
      ['SENT', false],
    ]);
    // Not deleted inside the transaction: the job does it after the commit.
    expect(await stored(fx)).toHaveLength(2);
    expect(await pendingFileJobs(fx)).toEqual(['DELETE_RECEIPT_FILE']);
    expect(await fx.runFileJobs()).toBe(2);
    expect(await stored(fx)).toEqual([]);
  });

  it('H4 (audit): a stopped batch whose UNCERTAIN receipts are all confirmed completes, and its files are deleted', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(3);
    fx.email.respondWith(UNCERTAIN, UNCERTAIN, UNCERTAIN);
    await startAndRunOnly(fx);
    expect(await fx.repository.batches.get(OCT_2026, 'CASH')).toMatchObject({ state: 'STOPPED', stopReason: 'PROVIDER_UNAVAILABLE' });
    expect(await fx.runFileJobs()).toBe(0);
    expect(await stored(fx)).toHaveLength(3);
    const [a, b, c] = fx.email.calls.map((call) => call.attemptId as string);
    const [, , third] = await receipts(fx);

    // Three ways of confirming a send: a webhook, the logs, the operator.
    await fx.deliver('w-a', { attemptId: a as string, recipient: 'admin@altos.com', state: 'ACCEPTED' });
    fx.lookup.setResult(b as string, { kind: 'FOUND', status: 'PROCESSED' });
    await fx.reconcile.execute(b as string, false);
    expect((await fx.repository.batches.get(OCT_2026, 'CASH'))?.state).toBe('STOPPED');
    await fx.resolve.execute('operador', third?.sha256 as never, 'SENT', 'seen in Processed Emails');
    expect(c).toBeDefined();

    expect((await receipts(fx)).map((r) => [r.state, r.fileAvailable])).toEqual([
      ['SENT', false],
      ['SENT', false],
      ['SENT', false],
    ]);
    expect(await fx.repository.batches.get(OCT_2026, 'CASH')).toMatchObject({ state: 'COMPLETED', stopReason: undefined });
    const completed = (await fx.repository.outbox.lockPending(1000)).map((p) => p.event).find((e) => e.type === 'BATCH_COMPLETED');
    expect(completed?.payload).toEqual({ period: '2026-10', block: 'CASH', by: 'settlement' });
    expect(await fx.runFileJobs()).toBe(3);
    expect(await stored(fx)).toEqual([]);

    // Nothing to send; a later upload reopens it as today.
    expect(await fx.start.execute('operador', OCT_2026, 'CASH', (await fx.repository.batches.get(OCT_2026, 'CASH'))?.manifestVersion ?? 0)).toEqual({
      ok: false,
      error: { code: 'BATCH_NOT_EXECUTABLE' },
    });
    await fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Nuevo', 'MULTA', '104522'), content: pdfBytes('nuevo') }]);
    expect((await fx.repository.batches.get(OCT_2026, 'CASH'))?.state).toBe('OPEN');
  });

  it('a stopped batch with a receipt still ready, or one still UNCERTAIN, is not closed', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(4);
    fx.email.respondWith(UNCERTAIN, UNCERTAIN, UNCERTAIN);
    await startAndRunOnly(fx);
    const [a, b, c] = fx.email.calls.map((call) => call.attemptId as string);
    for (const [id, attemptId] of [a, b, c].entries()) await fx.deliver(`w-${id}`, { attemptId: attemptId as string, recipient: 'admin@altos.com', state: 'ACCEPTED' });
    // The fourth receipt was never reached: still PENDING and ready.
    expect((await receipts(fx)).map((r) => r.state)).toEqual(['SENT', 'SENT', 'SENT', 'PENDING']);
    expect((await fx.repository.batches.get(OCT_2026, 'CASH'))?.state).toBe('STOPPED');
    expect((await receipts(fx))[3]?.fileAvailable).toBe(true);
  });

  it('late evidence (D34) also retires the file', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(3);
    fx.email.respondWith(UNCERTAIN, UNCERTAIN, UNCERTAIN);
    await startAndRunOnly(fx);
    const [a] = fx.email.calls.map((call) => call.attemptId as string);
    fx.clock.advance(61 * MINUTE);
    await fx.reconcile.execute(a as string, true);
    expect((await receipts(fx))[0]).toMatchObject({ state: 'FAILED', errorType: 'NOT_FOUND_AT_PROVIDER', fileAvailable: true });
    await fx.deliver('w-late', { attemptId: a as string, recipient: 'admin@altos.com', state: 'ACCEPTED' });
    expect((await receipts(fx))[0]).toMatchObject({ state: 'SENT', fileAvailable: false });
    expect(await fx.runFileJobs()).toBe(1);
    expect(await stored(fx)).toHaveLength(2);
  });

  it('a file uploaded again for a Resend before its deletion job ran is kept', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(1);
    await startAndRunOnly(fx);
    const [receipt] = await receipts(fx);
    await fx.deliver('w-hb', { attemptId: fx.email.calls[0]?.attemptId as string, recipient: 'admin@altos.com', state: 'HARD_BOUNCE' });
    // A2: the operator uploads it again for a Resend; the deletion queued when it was SENT has not run yet.
    await fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Edificio Altos 00', 'MULTA', '104522'), content: pdfBytes('receipt-0') }]);
    expect(await fx.receipt(receipt?.sha256 as string)).toMatchObject({ state: 'SENT', fileAvailable: true });
    expect(await fx.runFileJobs()).toBe(1);
    expect(await stored(fx)).toEqual([receipt?.sha256]);
  });
});

describe('D41: orphan file sweep', () => {
  it('a file whose deletion failed is left while recent and deleted once old enough; needed files are kept', async () => {
    const fx = deliveryFixture();
    await fx.uploadValid(2);
    fx.email.respondWith({ kind: 'ACCEPTED', providerRequestId: 'r' }, { kind: 'ACCOUNT_ERROR', detail: 'LE_102' });
    await startAndRunOnly(fx);
    // The deletion of the SENT receipt's file fails (disk full, permissions…): the job fails.
    vi.spyOn(fx.files, 'delete').mockRejectedValueOnce(new Error('EACCES'));
    await expect(fx.runFileJobs()).rejects.toThrow('EACCES');
    expect(await stored(fx)).toHaveLength(2);
    // A file nobody knows (e.g. a write whose transaction did not commit).
    await fx.files.save({ period: OCT_2026, block: 'CASH', sha256: 'f'.repeat(64) as never }, pdfBytes('stray'));

    expect(await fx.fileJobs.purgeOrphans.execute()).toEqual({ deleted: 0, tooRecent: 3, failed: 0 });
    fx.clock.advance(61 * MINUTE);
    expect(await fx.fileJobs.purgeOrphans.execute()).toEqual({ deleted: 2, tooRecent: 0, failed: 0 });
    // The PENDING receipt (stopped by the account error) keeps its file.
    const pending = (await receipts(fx)).find((r) => r.state === 'PENDING');
    expect(await stored(fx)).toEqual([pending?.sha256]);
  });

  it('is queued once while one is pending; failed deletions raise one alert', async () => {
    const fx = deliveryFixture();
    expect(await fx.fileJobs.purgeOrphans.request()).toBe(true);
    expect(await fx.fileJobs.purgeOrphans.request()).toBe(false);

    await fx.files.save({ period: OCT_2026, block: 'CASH', sha256: 'e'.repeat(64) as never }, pdfBytes('stray'));
    fx.clock.advance(61 * MINUTE);
    vi.spyOn(fx.files, 'delete').mockRejectedValue(new Error('EROFS'));
    expect(await fx.fileJobs.purgeOrphans.execute()).toEqual({ deleted: 0, tooRecent: 0, failed: 1 });
    expect(await fx.repository.alerts.list()).toMatchObject([{ type: 'FILE_PURGE_FAILED', detail: expect.stringContaining('EROFS') }]);
  });
});
