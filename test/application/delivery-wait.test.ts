import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../src/adapters/outbound/fakes/fixed-clock';
import { applyIncomingEvent } from '../../src/application/delivery/apply-delivery-event';
import type { DeliveryWaitPolicy } from '../../src/application/sending/execution-dependencies';
import type { SendLookup, SendLookupResult } from '../../src/ports/send-lookup';
import { OCT_2026 } from '../support/builders';
import { executionFixture, type ExecutionFixture } from '../support/execution-fixtures';

/** Logs answer chosen per call; records when (seconds into the run) each lookup happened. */
class ScriptedLookup implements SendLookup {
  readonly calls: Array<{ attemptId: string }> = [];
  constructor(private readonly answer: (attemptId: string, call: number) => SendLookupResult) {}
  async findByAttempt(attemptId: string): Promise<SendLookupResult> {
    this.calls.push({ attemptId });
    return this.answer(attemptId, this.calls.length);
  }
}

/** A clock whose sleeps can trigger work, like the delivery lane applying a webhook meanwhile. */
class HookedClock extends FixedClock {
  onSleep: (() => Promise<void>) | undefined;
  override async sleep(ms: number): Promise<void> {
    await super.sleep(ms);
    await this.onSleep?.();
  }
}

function fixture(lookup: SendLookup, maxSeconds = 120) {
  const policy: DeliveryWaitPolicy = { maxSeconds, lookupEverySeconds: 30, pollMs: 500, sendLookup: lookup };
  return executionFixture({ deliveryWait: policy });
}

const delivery = (fx: ExecutionFixture) =>
  fx.progress.events.filter((e) => e.event.type === 'WAITING_DELIVERY' || e.event.type === 'DELIVERY_RESOLVED').map((e) => e.event);

describe('wait for the delivery result before the next send (simulation branch)', () => {
  it('starts the next send only after the webhook of the previous one is applied', async () => {
    const hooked = new HookedClock();
    const fx = executionFixture({ clock: hooked, deliveryWait: { maxSeconds: 120, lookupEverySeconds: 30, pollMs: 500, sendLookup: new ScriptedLookup(() => ({ kind: 'NOT_FOUND' })) } });
    await fx.uploadValid(2);
    let sleeps = 0;
    hooked.onSleep = async () => {
      // The delivery lane applies the webhook 2 s into each wait (the 4th poll of 500 ms).
      const sending = (await fx.repository.receipts.listByBatch(OCT_2026, 'CASH')).find((r) => r.deliveryState === 'UNCONFIRMED');
      if (!sending) return;
      sleeps += 1;
      if (sleeps % 4 !== 0) return;
      const [attempt] = await fx.repository.attempts.listByReceipt(sending.sha256);
      await fx.repository.transaction((tx) =>
        applyIncomingEvent(tx, fx.execDeps.newId, hooked.now(), { eventId: `wh-${attempt!.attemptId}`, attemptId: attempt!.attemptId, recipient: attempt!.to, state: 'ACCEPTED', occurredAt: hooked.now(), source: 'WEBHOOK' }),
      );
    };
    await fx.startAndRun();

    expect(fx.email.calls).toHaveLength(2);
    const types = fx.progress.events.map((e) => e.event.type).filter((t) => t !== 'STARTED' && t !== 'FINISHED');
    expect(types).toEqual(['RECEIPT_PROCESSED', 'WAITING_DELIVERY', 'DELIVERY_RESOLVED', 'RECEIPT_PROCESSED', 'WAITING_DELIVERY', 'DELIVERY_RESOLVED']);
    expect(delivery(fx).filter((e) => e.type === 'DELIVERY_RESOLVED')).toMatchObject([{ result: 'ACCEPTED', seconds: 2 }, { result: 'ACCEPTED', seconds: 2 }]);
  });

  it('looks the send up in the logs every 30 s and takes what they show', async () => {
    const lookup = new ScriptedLookup((_, call) => (call === 1 ? { kind: 'FOUND', status: 'PROCESSED' } : { kind: 'FOUND', status: 'HARD_BOUNCE', detail: '550' }));
    const fx = fixture(lookup);
    await fx.uploadValid(1);
    await fx.startAndRun();
    expect(lookup.calls).toHaveLength(2);
    expect(delivery(fx)).toMatchObject([{ type: 'WAITING_DELIVERY' }, { type: 'DELIVERY_RESOLVED', result: 'HARD_BOUNCE', seconds: 60 }]);
    expect((await fx.repository.receipts.listByBatch(OCT_2026, 'CASH'))[0]).toMatchObject({ state: 'SENT', deliveryState: 'HARD_BOUNCE' });
  });

  it('a send that failed to process at the provider counts as resolved', async () => {
    const fx = fixture(new ScriptedLookup(() => ({ kind: 'FOUND', status: 'PROCESS_FAILED' })));
    await fx.uploadValid(1);
    await fx.startAndRun();
    expect(delivery(fx).at(-1)).toMatchObject({ type: 'DELIVERY_RESOLVED', result: 'PROCESS_FAILED', seconds: 30 });
  });

  it('after the maximum wait the send stays UNCONFIRMED, noted in its history, and the batch goes on', async () => {
    const lookup = new ScriptedLookup(() => ({ kind: 'NOT_FOUND' }));
    const fx = fixture(lookup);
    await fx.uploadValid(2);
    await fx.startAndRun();
    expect(fx.email.calls).toHaveLength(2);
    expect(lookup.calls).toHaveLength(8);
    expect(delivery(fx).filter((e) => e.type === 'DELIVERY_RESOLVED')).toMatchObject([{ result: 'TIMEOUT', seconds: 120 }, { result: 'TIMEOUT', seconds: 120 }]);
    const [receipt] = await fx.repository.receipts.listByBatch(OCT_2026, 'CASH');
    expect(receipt?.deliveryState).toBe('UNCONFIRMED');
    expect((await fx.repository.receipts.history(receipt!.sha256)).map((h) => h.event)).toContain('DELIVERY_WAIT_TIMEOUT');
    expect((await fx.repository.batches.get(OCT_2026, 'CASH'))?.state).toBe('COMPLETED');
  });

  it('does not wait after a rejected or uncertain send', async () => {
    const lookup = new ScriptedLookup(() => ({ kind: 'NOT_FOUND' }));
    const fx = fixture(lookup);
    fx.email.respondWith({ kind: 'RECEIPT_REJECTED', detail: 'SM_113 invalid address' });
    fx.email.respondWith({ kind: 'UNCERTAIN', detail: 'HTTP 503' });
    await fx.uploadValid(2);
    await fx.startAndRun();
    expect(fx.email.calls).toHaveLength(2);
    expect(delivery(fx)).toEqual([]);
    expect(lookup.calls).toHaveLength(0);
  });
});
