import { describe, expect, it } from 'vitest';

import type { EmailProvider } from '../../src/ports/email-provider';
import { RunExecution } from '../../src/application/sending/run-execution';
import type { SendOutcome } from '../../src/domain/sending/send-outcome';
import { OCT_2026 } from '../support/builders';
import { executionFixture, type ExecutionFixture } from '../support/execution-fixtures';
import { fileName, pdfBytes } from '../support/receipt-fixtures';

const UNCERTAIN = (retryAfterSeconds?: number): SendOutcome => ({ kind: 'UNCERTAIN', detail: 'HTTP 503', retryAfterSeconds });
const states = async (fx: ExecutionFixture) => (await fx.repository.receipts.listByBatch(OCT_2026, 'CASH')).map((r) => r.state);
const eventTypes = (fx: ExecutionFixture) => fx.progress.events.map((e) => e.event.type);

describe('StartExecution', () => {
  it('queues the execution, takes the global lock and audits it', async () => {
    const fx = executionFixture();
    const version = await fx.uploadValid(2);
    const started = await fx.start.execute('operador', OCT_2026, 'CASH', version);
    expect(started.ok).toBe(true);
    expect((await fx.repository.batches.get(OCT_2026, 'CASH'))?.state).toBe('RUNNING');
    expect((await fx.repository.executions.running())?.manifestVersion).toBe(version);
    expect((await fx.repository.audit.list()).at(-1)).toMatchObject({ action: 'BATCH_EXECUTED', newValue: 'manifest v1' });
    expect(await fx.jobs.claimNext(fx.clock.now())).toMatchObject({ type: 'EXECUTE_BATCH' });

    expect(await fx.start.execute('operador', OCT_2026, 'CASH', version)).toEqual({ ok: false, error: { code: 'EXECUTION_IN_PROGRESS' } });
  });

  it('refuses a reviewed version that is not the current one, with the differences, and sends nothing', async () => {
    const fx = executionFixture();
    await fx.uploadValid(1);
    await fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Nuevo', 'MULTA', '104522'), content: pdfBytes('new') }]);
    const result = await fx.start.execute('operador', OCT_2026, 'CASH', 1);
    expect(result).toMatchObject({ ok: false, error: { code: 'MANIFEST_CHANGED', currentVersion: 2, differences: [{ type: 'ADDED', fileName: fileName('Nuevo', 'MULTA', '104522') }] } });
    expect(await fx.repository.executions.running()).toBeUndefined();
  });

  it('refuses an empty manifest, a missing batch and a missing archive copy address', async () => {
    const fx = executionFixture();
    expect(await fx.start.execute('operador', OCT_2026, 'CASH', 0)).toEqual({ ok: false, error: { code: 'BATCH_NOT_FOUND' } });
    await fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: 'malo.pdf', content: pdfBytes('x') }]);
    expect(await fx.start.execute('operador', OCT_2026, 'CASH', 1)).toEqual({ ok: false, error: { code: 'NOTHING_TO_SEND' } });

    await fx.uploadValid(1);
    await fx.repository.settings.setArchiveCopyEnabled(true);
    expect(await fx.start.execute('operador', OCT_2026, 'CASH', 2)).toEqual({ ok: false, error: { code: 'ARCHIVE_COPY_NOT_CONFIGURED' } });
  });
});

describe('RunExecution', () => {
  it('sends every receipt once, in order, with client reference = attempt id; completes and purges files', async () => {
    const fx = executionFixture();
    await fx.uploadValid(3);
    const executionId = await fx.startAndRun();

    expect(await states(fx)).toEqual(['SENT', 'SENT', 'SENT']);
    expect(fx.email.calls.map((c) => c.attachment.name)).toEqual([0, 1, 2].map((i) => fileName(`Edificio Altos 0${i}`, 'MULTA', '104522')));
    const call = fx.email.calls[0];
    expect(call).toMatchObject({ to: 'admin@altos.com', subject: 'Multa – Octubre 2026', copyTo: undefined });
    expect(call?.textBody).toContain('Edificio Altos');

    const receipt = (await fx.repository.receipts.listByBatch(OCT_2026, 'CASH'))[0];
    const attempts = await fx.repository.attempts.listByReceipt(receipt?.sha256 as never);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attemptId: call?.attemptId, outcome: 'ACCEPTED', providerRequestId: `fake-${call?.attemptId}` });
    expect(receipt).toMatchObject({ deliveryState: 'UNCONFIRMED', attempts: 1, fileAvailable: false });

    expect(await fx.repository.executions.get(executionId)).toMatchObject({ result: 'COMPLETED' });
    expect((await fx.repository.batches.get(OCT_2026, 'CASH'))?.state).toBe('COMPLETED');
    expect(await fx.files.purgeBatch(OCT_2026, 'CASH')).toBe(0);
    expect(fx.clock.sleeps).toEqual([1000, 1000]);
    expect(eventTypes(fx)).toEqual(['STARTED', 'RECEIPT_PROCESSED', 'RECEIPT_PROCESSED', 'RECEIPT_PROCESSED', 'FINISHED']);
  });

  it('waits 30 s then 60 s after uncertain responses (reported before waiting) and stops at the third', async () => {
    const fx = executionFixture();
    await fx.uploadValid(5);
    fx.email.respondWith(UNCERTAIN(), UNCERTAIN(), UNCERTAIN());
    const executionId = await fx.startAndRun();

    expect(await states(fx)).toEqual(['UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'PENDING', 'PENDING']);
    expect(fx.email.calls).toHaveLength(3);
    expect(fx.clock.sleeps).toEqual([30_000, 1000, 60_000, 1000]);
    const waits = fx.progress.events.filter((e) => e.event.type === 'WAITING').map((e) => e.event);
    expect(waits).toMatchObject([
      { seconds: 30, consecutiveIncidents: 1, reason: 'HTTP 503' },
      { seconds: 60, consecutiveIncidents: 2 },
    ]);
    expect(await fx.repository.executions.get(executionId)).toMatchObject({ result: 'STOPPED', stopReason: 'PROVIDER_UNAVAILABLE' });
    expect((await fx.repository.batches.get(OCT_2026, 'CASH'))).toMatchObject({ state: 'STOPPED', stopReason: 'PROVIDER_UNAVAILABLE' });
    expect(fx.alerts.alerts).toEqual([]);
    await fx.relay.drain();
    expect(fx.alerts.alerts).toMatchObject([{ type: 'BATCH_STOPPED' }]);
    expect(await fx.repository.alerts.list()).toHaveLength(1);
  });

  it('a successful send resets the incident count', async () => {
    const fx = executionFixture();
    await fx.uploadValid(4);
    fx.email.respondWith(UNCERTAIN(), UNCERTAIN(), { kind: 'ACCEPTED', providerRequestId: 'r' }, UNCERTAIN());
    await fx.startAndRun();
    expect(await states(fx)).toEqual(['UNCERTAIN', 'UNCERTAIN', 'SENT', 'UNCERTAIN']);
    expect((await fx.repository.batches.get(OCT_2026, 'CASH'))?.state).toBe('COMPLETED');
  });

  it('stops at once when Retry-After exceeds the 10-minute ceiling', async () => {
    const fx = executionFixture();
    await fx.uploadValid(2);
    fx.email.respondWith(UNCERTAIN(900));
    await fx.startAndRun();
    expect(await states(fx)).toEqual(['UNCERTAIN', 'PENDING']);
    expect(fx.clock.sleeps).toEqual([]);
  });

  it('stops on an account error leaving the receipt PENDING', async () => {
    const fx = executionFixture();
    await fx.uploadValid(2);
    fx.email.respondWith({ kind: 'ACCOUNT_ERROR', detail: 'LE_102 credits exhausted' });
    await fx.startAndRun();
    expect(await states(fx)).toEqual(['PENDING', 'PENDING']);
    expect(await fx.repository.batches.get(OCT_2026, 'CASH')).toMatchObject({ state: 'STOPPED', stopReason: 'PROVIDER_ACCOUNT' });
  });

  it('M1: a rejection with an unknown code fails the receipt at once, with an alert and no wait; three in a row stop the batch', async () => {
    const fx = executionFixture();
    await fx.uploadValid(5);
    const unknown = { kind: 'UNKNOWN_REJECTION', detail: 'undocumented HTTP 400: TM_3004' } as const;
    fx.email.respondWith(unknown, unknown, unknown);
    await fx.startAndRun();
    expect((await fx.repository.receipts.listByBatch(OCT_2026, 'CASH')).map((r) => [r.state, r.errorType])).toEqual([
      ['FAILED', 'PROVIDER_REJECTED'],
      ['FAILED', 'PROVIDER_REJECTED'],
      ['FAILED', 'PROVIDER_REJECTED'],
      ['PENDING', undefined],
      ['PENDING', undefined],
    ]);
    expect(fx.clock.sleeps).toEqual([1000, 1000]);
    expect(fx.progress.events.filter((e) => e.event.type === 'WAITING')).toEqual([]);
    expect(await fx.repository.batches.get(OCT_2026, 'CASH')).toMatchObject({ state: 'STOPPED', stopReason: 'PROVIDER_UNKNOWN_ERROR' });
    expect((await fx.repository.alerts.list()).map((a) => a.type)).toEqual(['PROVIDER_UNKNOWN_ERROR', 'PROVIDER_UNKNOWN_ERROR', 'PROVIDER_UNKNOWN_ERROR', 'BATCH_STOPPED']);
  });

  it('continues after a receipt-level rejection; the FAILED receipt is retried by a later execution', async () => {
    const fx = executionFixture();
    await fx.uploadValid(2);
    fx.email.respondWith({ kind: 'RECEIPT_REJECTED', detail: 'SM_113 invalid address' });
    await fx.startAndRun();
    const receipts = await fx.repository.receipts.listByBatch(OCT_2026, 'CASH');
    expect(receipts.map((r) => [r.state, r.errorType])).toEqual([
      ['FAILED', 'PROVIDER_REJECTED'],
      ['SENT', undefined],
    ]);
  });

  it('stops on an error in our request', async () => {
    const fx = executionFixture();
    await fx.uploadValid(2);
    fx.email.respondWith({ kind: 'REQUEST_ERROR', detail: 'GE_102' });
    await fx.startAndRun();
    expect(await states(fx)).toEqual(['FAILED', 'PENDING']);
    expect(await fx.repository.batches.get(OCT_2026, 'CASH')).toMatchObject({ stopReason: 'INTERNAL_ERROR' });
  });

  it('connection failures do not wait and stop at the third in a row', async () => {
    const fx = executionFixture();
    await fx.uploadValid(4);
    const down: SendOutcome = { kind: 'CONNECTION_FAILED', detail: 'ECONNREFUSED' };
    fx.email.respondWith(down, down, down);
    await fx.startAndRun();
    expect(await states(fx)).toEqual(['FAILED', 'FAILED', 'FAILED', 'PENDING']);
    expect(fx.clock.sleeps).toEqual([1000, 1000]);
  });

  it('does not send when the email changed since review, the file changed or the address was suppressed', async () => {
    const fx = executionFixture();
    await fx.uploadValid(3);
    const [first, second, third] = await fx.repository.receipts.listByBatch(OCT_2026, 'CASH');
    await fx.files.save({ period: OCT_2026, block: 'CASH', sha256: second?.sha256 as never }, pdfBytes('tampered'));
    // The source changes the email while the batch runs: affects every receipt of the contract after the change.
    fx.email.respondWith((email) => {
      fx.tayrona.setContract('104522', { complexName: 'Edificio Altos', email: 'nuevo@altos.com' });
      return { kind: 'ACCEPTED', providerRequestId: email.attemptId };
    });
    await fx.startAndRun();
    const after = await fx.repository.receipts.listByBatch(OCT_2026, 'CASH');
    expect(after.map((r) => [r.sha256, r.state, r.errorType])).toEqual([
      [first?.sha256, 'SENT', undefined],
      [second?.sha256, 'FAILED', 'FILE_MODIFIED'],
      [third?.sha256, 'FAILED', 'RECIPIENT_CHANGED'],
    ]);
    expect(fx.email.calls).toHaveLength(1);
  });

  it('marks receipts FAILED / SOURCE_UNAVAILABLE and stops after three source failures in a row', async () => {
    const fx = executionFixture();
    await fx.uploadValid(4);
    fx.tayrona.setUnavailable(true);
    await fx.startAndRun();
    const receipts = await fx.repository.receipts.listByBatch(OCT_2026, 'CASH');
    expect(receipts.map((r) => [r.state, r.errorType])).toEqual([
      ['FAILED', 'SOURCE_UNAVAILABLE'],
      ['FAILED', 'SOURCE_UNAVAILABLE'],
      ['FAILED', 'SOURCE_UNAVAILABLE'],
      ['PENDING', undefined],
    ]);
    expect(await fx.repository.batches.get(OCT_2026, 'CASH')).toMatchObject({ stopReason: 'SOURCE_UNAVAILABLE' });
    expect(fx.email.calls).toHaveLength(0);
  });

  it('carries the archive copy in force when the execution started', async () => {
    const fx = executionFixture({ archiveCopyAddress: 'archivo@anutibara.com' });
    await fx.repository.settings.setArchiveCopyEnabled(true);
    await fx.uploadValid(1);
    await fx.startAndRun();
    expect(fx.email.calls[0]?.copyTo).toBe('archivo@anutibara.com');
    const receipt = (await fx.repository.receipts.listByBatch(OCT_2026, 'CASH'))[0];
    expect((await fx.repository.attempts.listByReceipt(receipt?.sha256 as never))[0]?.copyAddress).toBe('archivo@anutibara.com');
  });

  it('after a stop, sending the same version again only processes the receipts not yet sent', async () => {
    const fx = executionFixture();
    await fx.uploadValid(3);
    fx.email.respondWith({ kind: 'ACCOUNT_ERROR', detail: 'LE_102' });
    await fx.startAndRun();
    fx.email.calls.length = 0;
    fx.email.respondWith({ kind: 'ACCEPTED', providerRequestId: 'a' });

    // A receipt that reached SENT (e.g. resolved by reconciliation) must not be sent again.
    const [first] = await fx.repository.receipts.listByBatch(OCT_2026, 'CASH');
    if (!first) throw new Error('missing receipt');
    await fx.repository.receipts.save({ ...first, state: 'SENT' });
    await fx.startAndRun();
    expect(fx.email.calls).toHaveLength(2);
    expect(await states(fx)).toEqual(['SENT', 'SENT', 'SENT']);
  });
});

describe('RecoverAfterCrash', () => {
  it('turns SENDING receipts into UNCERTAIN and stops the running execution as INTERRUPTED', async () => {
    const fx = executionFixture();
    await fx.uploadValid(3);
    // The process dies while the provider holds the second email: the run never gets an answer. (A thrown error is
    // no longer a crash: since D32 the run handles it itself, see "unexpected exceptions" below.)
    let crash: () => void = () => undefined;
    const crashed = new Promise<void>((resolve) => {
      crash = resolve;
    });
    let calls = 0;
    const dying: EmailProvider = {
      send: async () => {
        calls += 1;
        if (calls === 1) return { kind: 'ACCEPTED', providerRequestId: 'r1' };
        crash();
        return new Promise<never>(() => undefined);
      },
    };
    const run = new RunExecution({ ...fx.execDeps, emailProvider: dying });
    const started = await fx.start.execute('operador', OCT_2026, 'CASH', 1);
    if (!started.ok) throw new Error('not started');
    void run.execute(started.value.executionId);
    await crashed;
    expect(await states(fx)).toEqual(['SENT', 'SENDING', 'PENDING']);

    expect(await fx.recover.execute()).toEqual({ uncertain: 1, interrupted: started.value.executionId });
    expect(await states(fx)).toEqual(['SENT', 'UNCERTAIN', 'PENDING']);
    expect(await fx.repository.batches.get(OCT_2026, 'CASH')).toMatchObject({ state: 'STOPPED', stopReason: 'INTERRUPTED' });
    expect(await fx.repository.executions.running()).toBeUndefined();

    // The abandoned job, if released, finds the execution finished and does nothing.
    await run.execute(started.value.executionId);
    expect(await states(fx)).toEqual(['SENT', 'UNCERTAIN', 'PENDING']);
  });

  it('D54: keeps the counters of the interrupted execution even when its last event carries none (a WAITING)', async () => {
    const fx = executionFixture();
    await fx.uploadValid(3);
    let crash: () => void = () => undefined;
    const crashed = new Promise<void>((resolve) => {
      crash = resolve;
    });
    let calls = 0;
    const dying: EmailProvider = {
      send: async () => {
        calls += 1;
        if (calls === 1) return { kind: 'ACCEPTED', providerRequestId: 'r1' };
        crash();
        return new Promise<never>(() => undefined);
      },
    };
    const run = new RunExecution({ ...fx.execDeps, emailProvider: dying });
    const started = await fx.start.execute('operador', OCT_2026, 'CASH', 1);
    if (!started.ok) throw new Error('not started');
    void run.execute(started.value.executionId);
    await crashed;
    // The process died while a growing wait was announced: the last stored event has no counters.
    await fx.repository.executionEvents.append(started.value.executionId, fx.clock.now(), { type: 'WAITING', reason: 'HTTP 503', seconds: 30, consecutiveIncidents: 1, nextSendAt: new Date(fx.clock.now().getTime() + 30_000).toISOString() });

    await fx.recover.execute();
    const finished = (await fx.repository.executionEvents.last(started.value.executionId))?.event;
    expect(finished).toMatchObject({ type: 'FINISHED', stopReason: 'INTERRUPTED', counters: { total: 3, processed: 1 } });
    expect(await fx.status.byId(started.value.executionId)).toMatchObject({ result: 'STOPPED', counters: { total: 3, processed: 1 } });
  });
});

describe('GetExecution (D10)', () => {
  it('reports the running execution with its counters and current wait, from the database', async () => {
    const fx = executionFixture();
    await fx.uploadValid(3);
    let status: Awaited<ReturnType<typeof fx.status.current>>;
    // Observe the state from inside the wait, as a new session would.
    fx.email.respondWith(UNCERTAIN());
    const sleep = fx.clock.sleep.bind(fx.clock);
    fx.clock.sleep = async (ms) => {
      if (ms === 30_000) status = await fx.status.current();
      await sleep(ms);
    };
    await fx.startAndRun();
    expect(status).toMatchObject({
      batchState: 'RUNNING',
      counters: { total: 3, processed: 1, byState: { UNCERTAIN: 1 } },
      waiting: { seconds: 30, consecutiveIncidents: 1 },
    });
    expect(status?.lastEventSeq).toBeGreaterThan(0);

    const finished = await fx.status.current();
    expect(finished).toMatchObject({ result: 'COMPLETED', batchState: 'COMPLETED', counters: { total: 3, processed: 3 }, waiting: undefined });
  });
});
