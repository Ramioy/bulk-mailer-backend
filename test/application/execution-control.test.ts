import { describe, expect, it, vi } from 'vitest';

import { RunExecution } from '../../src/application/sending/run-execution';
import type { SendOutcome } from '../../src/domain/sending/send-outcome';
import type { EmailProvider, OutgoingEmail } from '../../src/ports/email-provider';
import type { DomainEvent, DomainEventType } from '../../src/ports/event-bus';
import { OCT_2026 } from '../support/builders';
import { executionFixture, type ExecutionFixture } from '../support/execution-fixtures';
import { fileName, pdfBytes } from '../support/receipt-fixtures';

const ACCEPTED: SendOutcome = { kind: 'ACCEPTED', providerRequestId: 'r' };
const receipts = (fx: ExecutionFixture) => fx.repository.receipts.listByBatch(OCT_2026, 'CASH');
const states = async (fx: ExecutionFixture) => (await receipts(fx)).map((r) => r.state);
const eventTypes = (fx: ExecutionFixture) => fx.progress.events.map((e) => e.event.type);

async function startExecution(fx: ExecutionFixture): Promise<string> {
  const batch = await fx.repository.batches.get(OCT_2026, 'CASH');
  const started = await fx.start.execute('operador', OCT_2026, 'CASH', batch?.manifestVersion ?? 0);
  if (!started.ok) throw new Error(started.error.code);
  // Taken off the queue here: each test runs the execution itself (and a later `startAndRun` must get its own job).
  const job = await fx.jobs.claimNext(fx.clock.now(), ['EXECUTE_BATCH']);
  if (job) await fx.jobs.complete(job.jobId);
  return started.value.executionId;
}

/** Delivers the outbox and returns the events of the given types. */
async function published(fx: ExecutionFixture, ...types: DomainEventType[]): Promise<DomainEvent[]> {
  const seen: DomainEvent[] = [];
  for (const type of types) fx.bus.subscribe(type, async (event) => void seen.push(event));
  await fx.relay.drain();
  return seen;
}

/** Accepts every email except call number `holdAt`, whose answer waits until `release` (a send in flight). */
class HeldProvider implements EmailProvider {
  readonly calls: OutgoingEmail[] = [];
  private answer: (outcome: SendOutcome) => void = () => undefined;
  private reached: () => void = () => undefined;
  /** Resolves when the held call is being made. */
  readonly held = new Promise<void>((resolve) => {
    this.reached = resolve;
  });

  constructor(private readonly holdAt: number) {}

  send(email: OutgoingEmail): Promise<SendOutcome> {
    this.calls.push(email);
    if (this.calls.length !== this.holdAt) return Promise.resolve(ACCEPTED);
    this.reached();
    return new Promise((resolve) => {
      this.answer = resolve;
    });
  }

  release(outcome: SendOutcome): void {
    this.answer(outcome);
  }
}

describe('D32: an unexpected exception inside the execution does not leave the system locked', () => {
  it('H2 (audit): the file store fails before the provider call → receipt PENDING, STOPPED / INTERNAL_ERROR, lock released', async () => {
    const fx = executionFixture();
    await fx.uploadValid(2);
    const executionId = await startExecution(fx);
    vi.spyOn(fx.files, 'read').mockRejectedValueOnce(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }));

    // Still thrown, so the job is marked failed and logged, but the state is consistent.
    await expect(fx.run.execute(executionId)).rejects.toThrow('EIO');
    expect(fx.email.calls).toHaveLength(0);
    expect(await states(fx)).toEqual(['PENDING', 'PENDING']);
    const [first] = await receipts(fx);
    expect(first).toMatchObject({ attempts: 1, errorType: undefined, errorDetail: 'internal error: Error: EIO: i/o error, read' });
    expect((await fx.repository.receipts.history(first?.sha256 as never)).at(-1)).toMatchObject({
      event: 'PENDING',
      detail: 'internal error before calling the provider: Error: EIO: i/o error, read',
    });
    const [attempt] = await fx.repository.attempts.listByReceipt(first?.sha256 as never);
    expect(attempt).toMatchObject({ detail: 'not sent: internal error (Error: EIO: i/o error, read)' });
    expect(attempt?.outcome).toBeUndefined();

    expect(await fx.repository.executions.get(executionId)).toMatchObject({ result: 'STOPPED', stopReason: 'INTERNAL_ERROR' });
    expect(await fx.repository.batches.get(OCT_2026, 'CASH')).toMatchObject({ state: 'STOPPED', stopReason: 'INTERNAL_ERROR' });
    expect(await fx.repository.executions.running()).toBeUndefined();
    expect(eventTypes(fx)).toEqual(['STARTED', 'FINISHED']);
    expect(fx.progress.events.at(-1)?.event).toMatchObject({ batchState: 'STOPPED', stopReason: 'INTERNAL_ERROR', counters: { processed: 1, byState: { PENDING: 1 } } });
    const events = await published(fx, 'EXECUTION_FINISHED', 'RECEIPT_SEND_FAILED');
    expect(events.map((e) => [e.type, e.payload.stopReason ?? e.payload.state])).toEqual([
      ['RECEIPT_SEND_FAILED', 'PENDING'],
      ['EXECUTION_FINISHED', 'INTERNAL_ERROR'],
    ]);
    expect(fx.alerts.alerts).toMatchObject([{ type: 'BATCH_STOPPED', subject: executionId, detail: '2026-10/CASH stopped: INTERNAL_ERROR' }]);

    // Every command works again (before D32: EXECUTION_IN_PROGRESS for all of them until a restart).
    const upload = await fx.upload.execute('operador', OCT_2026, 'CASH', [{ name: fileName('Nueva', 'MULTA', '104522'), content: pdfBytes('nueva') }]);
    expect(upload.ok).toBe(true);
    await fx.startAndRun();
    expect(await states(fx)).toEqual(['SENT', 'SENT', 'SENT']);
  });

  it('an exception from the provider call → receipt UNCERTAIN (never sent again blindly), reconciliation scheduled', async () => {
    const fx = executionFixture();
    await fx.uploadValid(3);
    const failing: EmailProvider = {
      send: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'status')");
      },
    };
    const run = new RunExecution({ ...fx.execDeps, emailProvider: failing });
    const executionId = await startExecution(fx);
    await expect(run.execute(executionId)).rejects.toThrow('reading');

    expect(await states(fx)).toEqual(['UNCERTAIN', 'PENDING', 'PENDING']);
    const [first] = await receipts(fx);
    const [attempt] = await fx.repository.attempts.listByReceipt(first?.sha256 as never);
    expect(attempt).toMatchObject({ outcome: 'UNCERTAIN', detail: expect.stringContaining('internal error after calling the provider: TypeError') });
    expect((await fx.repository.receipts.history(first?.sha256 as never)).at(-1)?.detail).toContain('internal error after calling the provider');
    expect(await fx.repository.batches.get(OCT_2026, 'CASH')).toMatchObject({ state: 'STOPPED', stopReason: 'INTERNAL_ERROR' });
    const [uncertain] = await published(fx, 'RECEIPT_UNCERTAIN');
    expect(uncertain?.payload).toMatchObject({ sha256: first?.sha256, attemptId: attempt?.attemptId, executionId, reason: 'INTERNAL_ERROR', providerCalled: true });
  });

  it('an exception after the outcome was recorded leaves that outcome as it is', async () => {
    const fx = executionFixture();
    await fx.uploadValid(2);
    const append = fx.repository.executionEvents.append.bind(fx.repository.executionEvents);
    // STARTED is stored; the RECEIPT_PROCESSED of the first receipt fails.
    vi.spyOn(fx.repository.executionEvents, 'append')
      .mockImplementationOnce(append)
      .mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    const executionId = await startExecution(fx);
    await expect(fx.run.execute(executionId)).rejects.toThrow('connection terminated');

    expect(await states(fx)).toEqual(['SENT', 'PENDING']);
    expect(fx.email.calls).toHaveLength(1);
    expect(await fx.repository.executions.get(executionId)).toMatchObject({ result: 'STOPPED', stopReason: 'INTERNAL_ERROR' });
    expect(fx.progress.events.at(-1)?.event).toMatchObject({ type: 'FINISHED', counters: { processed: 1, byState: { SENT: 1 } } });
  });

  it('if stopping fails too (database down), the error propagates and the operator abort covers it later', async () => {
    const fx = executionFixture();
    await fx.uploadValid(2);
    const transaction = fx.repository.transaction.bind(fx.repository);
    let databaseDown = false;
    vi.spyOn(fx.repository, 'transaction').mockImplementation((work) => (databaseDown ? Promise.reject(new Error('ECONNREFUSED')) : transaction(work)));
    const dying: EmailProvider = {
      send: async () => {
        databaseDown = true;
        throw new Error('socket hang up');
      },
    };
    const executionId = await startExecution(fx);
    const error = await new RunExecution({ ...fx.execDeps, emailProvider: dying }).execute(executionId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as Error).message).toBe('Error: socket hang up; stopping the execution failed too: Error: ECONNREFUSED');
    expect(await fx.repository.executions.running()).toMatchObject({ executionId });
    expect(await states(fx)).toEqual(['SENDING', 'PENDING']);

    databaseDown = false;
    const aborted = await fx.abort.execute('supervisor', executionId, 'job failed with the database down', true);
    expect(aborted).toMatchObject({ ok: true, value: { stopReason: 'INTERRUPTED', uncertain: [(await receipts(fx))[0]?.sha256] } });
    expect(await states(fx)).toEqual(['UNCERTAIN', 'PENDING']);
    expect(await fx.repository.executions.running()).toBeUndefined();
  });

  it('a re-claimed job of a finished execution does nothing', async () => {
    const fx = executionFixture();
    await fx.uploadValid(2);
    vi.spyOn(fx.files, 'read').mockRejectedValueOnce(new Error('EIO'));
    const executionId = await startExecution(fx);
    await expect(fx.run.execute(executionId)).rejects.toThrow('EIO');
    const before = { events: fx.progress.events.length, history: (await fx.repository.receipts.history((await receipts(fx))[0]?.sha256 as never)).length };

    await fx.run.execute(executionId);
    expect(fx.email.calls).toHaveLength(0);
    expect(fx.progress.events).toHaveLength(before.events);
    expect((await fx.repository.receipts.history((await receipts(fx))[0]?.sha256 as never)).length).toBe(before.history);
    expect(await fx.repository.executions.get(executionId)).toMatchObject({ stopReason: 'INTERNAL_ERROR' });
  });
});

describe('D32: operator abort of an execution that stopped making progress', () => {
  it('is refused while the execution showed progress recently; accepted after EXECUTION_ABORT_AFTER_MINUTES', async () => {
    const fx = executionFixture();
    await fx.uploadValid(3);
    const provider = new HeldProvider(2);
    const executionId = await startExecution(fx);
    // The run hangs in the second provider call: one receipt SENT, one SENDING, one PENDING.
    void new RunExecution({ ...fx.execDeps, emailProvider: provider }).execute(executionId);
    await provider.held;
    expect(await states(fx)).toEqual(['SENT', 'SENDING', 'PENDING']);

    // The last progress event (the first receipt processed), not the pause after it.
    const lastActivity = fx.progress.events.at(-1)?.at as Date;
    fx.clock.advance(9 * 60_000);
    expect(await fx.abort.execute('operador', executionId, 'stuck', false)).toEqual({
      ok: false,
      error: { code: 'EXECUTION_STILL_ACTIVE', lastActivityAt: lastActivity.toISOString(), abortableAt: new Date(lastActivity.getTime() + 10 * 60_000).toISOString() },
    });
    expect(await fx.repository.executions.running()).toMatchObject({ executionId });

    fx.clock.advance(60_000);
    const aborted = await fx.abort.execute('operador', executionId, '  no progress for 10 minutes  ', false);
    const [, second] = await receipts(fx);
    expect(aborted).toEqual({ ok: true, value: { executionId, result: 'STOPPED', stopReason: 'INTERRUPTED', uncertain: [second?.sha256] } });
    expect(await states(fx)).toEqual(['SENT', 'UNCERTAIN', 'PENDING']);
    expect((await fx.repository.receipts.history(second?.sha256 as never)).at(-1)).toMatchObject({ event: 'UNCERTAIN', detail: 'execution aborted by operador' });
    expect(await fx.repository.executions.get(executionId)).toMatchObject({ result: 'STOPPED', stopReason: 'INTERRUPTED' });
    expect(await fx.repository.batches.get(OCT_2026, 'CASH')).toMatchObject({ state: 'STOPPED', stopReason: 'INTERRUPTED' });
    expect(fx.progress.events.at(-1)?.event).toMatchObject({ type: 'FINISHED', batchState: 'STOPPED', stopReason: 'INTERRUPTED', counters: { processed: 1 } });
    expect((await fx.repository.audit.list()).at(-1)).toMatchObject({
      action: 'EXECUTION_ABORTED',
      actor: 'operador',
      subject: executionId,
      newValue: 'STOPPED / INTERRUPTED, 1 receipt(s) UNCERTAIN',
      note: 'no progress for 10 minutes',
    });
    const attempt = (await fx.repository.attempts.listByReceipt(second?.sha256 as never)).at(-1);
    const events = await published(fx, 'RECEIPT_UNCERTAIN', 'EXECUTION_FINISHED');
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      ['RECEIPT_UNCERTAIN', { sha256: second?.sha256, reason: 'execution aborted by operador', attemptId: attempt?.attemptId, executionId }],
      ['EXECUTION_FINISHED', { executionId, result: 'STOPPED', stopReason: 'INTERRUPTED' }],
    ]);
    expect(fx.alerts.alerts).toMatchObject([{ type: 'BATCH_STOPPED', detail: '2026-10/CASH stopped: INTERRUPTED' }]);

    // Idempotent for the operator: a second abort (double click) is refused and changes nothing.
    expect(await fx.abort.execute('operador', executionId, 'again', false)).toEqual({ ok: false, error: { code: 'EXECUTION_NOT_RUNNING' } });
    expect((await fx.repository.audit.list()).filter((a) => a.action === 'EXECUTION_ABORTED')).toHaveLength(1);
  });

  it('is accepted at once with force (audited as forced); requires a note; unknown executions are reported', async () => {
    const fx = executionFixture();
    await fx.uploadValid(1);
    const executionId = await startExecution(fx);
    expect(await fx.abort.execute('operador', 'nope', 'x', true)).toEqual({ ok: false, error: { code: 'EXECUTION_NOT_FOUND' } });
    expect(await fx.abort.execute('operador', executionId, '   ', true)).toEqual({ ok: false, error: { code: 'NOTE_REQUIRED' } });
    // Never claimed: no progress at all, the start counts as the last activity.
    expect(await fx.abort.execute('operador', executionId, 'x', false)).toMatchObject({ ok: false, error: { code: 'EXECUTION_STILL_ACTIVE' } });

    expect(await fx.abort.execute('operador', executionId, 'job queue is stuck', true)).toMatchObject({ ok: true, value: { uncertain: [] } });
    expect((await fx.repository.audit.list()).at(-1)).toMatchObject({ action: 'EXECUTION_ABORTED', note: '[forced] job queue is stuck' });
    expect(await states(fx)).toEqual(['PENDING']);

    // The job, claimed later, finds the execution finished and does nothing.
    await fx.run.execute(executionId);
    expect(fx.email.calls).toHaveLength(0);
    expect(await states(fx)).toEqual(['PENDING']);
  });

  it('a growing wait counts as activity until the next send is due', async () => {
    const fx = executionFixture();
    await fx.uploadValid(1);
    const executionId = await startExecution(fx);
    const nextSendAt = new Date(fx.clock.now().getTime() + 10 * 60_000);
    await fx.repository.executionEvents.append(executionId, fx.clock.now(), {
      type: 'WAITING',
      reason: 'HTTP 429',
      seconds: 600,
      consecutiveIncidents: 1,
      nextSendAt: nextSendAt.toISOString(),
    });
    fx.clock.advance(15 * 60_000);
    expect(await fx.abort.execute('operador', executionId, 'x', false)).toMatchObject({
      ok: false,
      error: { code: 'EXECUTION_STILL_ACTIVE', lastActivityAt: nextSendAt.toISOString() },
    });
    fx.clock.advance(5 * 60_000);
    expect(await fx.abort.execute('operador', executionId, 'x', false)).toMatchObject({ ok: true });
  });

  it('a run that was still alive notices the abort: it settles its send and takes no other receipt', async () => {
    const fx = executionFixture();
    await fx.uploadValid(3);
    const provider = new HeldProvider(2);
    const executionId = await startExecution(fx);
    const running = new RunExecution({ ...fx.execDeps, emailProvider: provider }).execute(executionId);
    await provider.held;
    await fx.abort.execute('operador', executionId, 'looked stuck', true);
    const finishedEvents = fx.progress.events.length;

    // The provider answers after the abort: the evidence settles the UNCERTAIN receipt; nothing else is sent.
    provider.release(ACCEPTED);
    await running;
    expect(provider.calls).toHaveLength(2);
    expect(await states(fx)).toEqual(['SENT', 'SENT', 'PENDING']);
    const [, second] = await receipts(fx);
    expect((await fx.repository.receipts.history(second?.sha256 as never)).at(-1)).toMatchObject({ event: 'SENT', detail: 'ACCEPTED (after the execution was aborted)' });
    expect(await fx.repository.executions.get(executionId)).toMatchObject({ result: 'STOPPED', stopReason: 'INTERRUPTED' });
    expect(fx.progress.events).toHaveLength(finishedEvents);

    // A new execution sends the rest, once.
    await fx.startAndRun();
    expect(await states(fx)).toEqual(['SENT', 'SENT', 'SENT']);
    expect(provider.calls.length + fx.email.calls.length).toBe(3);
  });

  it('an answer that cannot settle the released receipt is only kept on the attempt', async () => {
    const fx = executionFixture();
    await fx.uploadValid(2);
    const provider = new HeldProvider(1);
    const executionId = await startExecution(fx);
    const running = new RunExecution({ ...fx.execDeps, emailProvider: provider }).execute(executionId);
    await provider.held;
    await fx.abort.execute('operador', executionId, 'looked stuck', true);
    provider.release({ kind: 'UNCERTAIN', detail: 'timeout' });
    await running;

    const [first] = await receipts(fx);
    expect(await states(fx)).toEqual(['UNCERTAIN', 'PENDING']);
    expect((await fx.repository.attempts.listByReceipt(first?.sha256 as never))[0]).toMatchObject({ outcome: 'UNCERTAIN', detail: 'timeout' });
    expect((await fx.repository.receipts.history(first?.sha256 as never)).at(-1)?.event).toBe('OUTCOME_NOT_APPLIED');
  });
});
