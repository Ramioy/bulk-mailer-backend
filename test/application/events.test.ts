import { describe, expect, it } from 'vitest';

import { InProcessEventBus } from '../../src/adapters/outbound/events/in-process-event-bus';
import { FixedClock } from '../../src/adapters/outbound/fakes/fixed-clock';
import { InMemoryBulkMailerRepository } from '../../src/adapters/outbound/in-memory/in-memory-bulk-mailer-repository';
import { ListDeadEvents, RetryDeadEvent } from '../../src/application/events/dead-events';
import { MAX_DELIVERY_ATTEMPTS, OutboxRelay } from '../../src/application/events/outbox-relay';
import type { DomainEvent } from '../../src/ports/event-bus';
import { T0 } from '../support/builders';
import { executionFixture } from '../support/execution-fixtures';

const event = (eventId: string): DomainEvent => ({ eventId, type: 'RECEIPT_SENT', occurredAt: T0, payload: {} });

describe('OutboxRelay and InProcessEventBus', () => {
  it('delivers each committed event once to its subscribers, in order', async () => {
    const repo = new InMemoryBulkMailerRepository();
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    bus.subscribe('RECEIPT_SENT', async (e) => void seen.push(e.eventId));
    await repo.outbox.add(event('a'));
    await repo.outbox.add(event('b'));
    const relay = new OutboxRelay(repo, bus, new FixedClock());
    expect(await relay.drain()).toBe(2);
    expect(await relay.drain()).toBe(0);
    expect(seen).toEqual(['a', 'b']);
  });

  it('delivers again when a consumer fails (at-least-once), and gives up after the maximum attempts', async () => {
    const repo = new InMemoryBulkMailerRepository();
    const bus = new InProcessEventBus();
    let failures = 2;
    const seen: string[] = [];
    bus.subscribe('RECEIPT_SENT', async (e) => {
      if (failures-- > 0) throw new Error('consumer down');
      seen.push(e.eventId);
    });
    await repo.outbox.add(event('a'));
    const relay = new OutboxRelay(repo, bus, new FixedClock());
    expect(await relay.drain()).toBe(0);
    expect(await relay.drain()).toBe(0);
    expect(await relay.drain()).toBe(1);
    expect(seen).toEqual(['a']);

    bus.subscribe('ALERT_RAISED', async () => {
      throw new Error('always');
    });
    await repo.outbox.add({ ...event('x'), type: 'ALERT_RAISED' });
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 2; i += 1) await relay.drain();
    // D39: given up after the maximum attempts: dead, out of the pending window, kept with its error.
    expect(await repo.transaction((tx) => tx.outbox.lockPending(10))).toEqual([]);
    expect(await repo.outbox.listDead(10)).toMatchObject([{ event: { ...event('x'), type: 'ALERT_RAISED' }, attempts: MAX_DELIVERY_ATTEMPTS, lastError: 'Error: always' }]);
  });

  it('use cases record their domain events in the same transaction as their changes', async () => {
    const fx = executionFixture();
    fx.email.respondWith({ kind: 'ACCOUNT_ERROR', detail: 'LE_102' });
    await fx.uploadValid(2);
    await fx.startAndRun();

    const types: string[] = [];
    fx.bus.subscribe('RECEIPTS_UPLOADED', async (e) => void types.push(e.type));
    fx.bus.subscribe('EXECUTION_STARTED', async (e) => void types.push(e.type));
    fx.bus.subscribe('RECEIPT_SEND_FAILED', async (e) => void types.push(`${e.type}:${String(e.payload.state)}`));
    fx.bus.subscribe('EXECUTION_FINISHED', async (e) => void types.push(`${e.type}:${String(e.payload.stopReason)}`));
    await fx.relay.drain();
    expect(types).toEqual(['RECEIPTS_UPLOADED', 'EXECUTION_STARTED', 'RECEIPT_SEND_FAILED:PENDING', 'EXECUTION_FINISHED:PROVIDER_ACCOUNT']);
    expect(fx.alerts.alerts).toMatchObject([{ type: 'BATCH_STOPPED', raisedAt: expect.any(Date) }]);
  });
});

describe('D39: dead outbox events', () => {
  const failing = (repo: InMemoryBulkMailerRepository, poisoned: (e: DomainEvent) => boolean) => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    const alerts: string[] = [];
    bus.subscribe('RECEIPT_SENT', async (e) => {
      if (poisoned(e)) throw new Error(`cannot handle ${e.eventId}`);
      seen.push(e.eventId);
    });
    bus.subscribe('ALERT_RAISED', async (e) => void alerts.push(String((e.payload.alert as { type: string }).type)));
    let n = 0;
    return { relay: new OutboxRelay(repo, bus, new FixedClock(), { newId: () => `id-${(n += 1)}` }), seen, alerts, bus };
  };

  it('a poisoned event dies after the maximum attempts, with one alert, and the events behind it are delivered', async () => {
    const repo = new InMemoryBulkMailerRepository();
    const { relay, seen, alerts } = failing(repo, (e) => e.eventId === 'bad');
    await repo.outbox.add(event('bad'));
    await repo.outbox.add(event('good'));
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i += 1) await relay.drain();
    expect(seen).toEqual(['good']);
    const [dead] = await repo.outbox.listDead(10);
    expect(dead).toMatchObject({ event: { eventId: 'bad' }, attempts: MAX_DELIVERY_ATTEMPTS, lastError: 'Error: cannot handle bad' });
    expect(await repo.alerts.list()).toMatchObject([{ type: 'OUTBOX_EVENT_DEAD', subject: 'bad', detail: 'RECEIPT_SENT not delivered after 10 attempts: Error: cannot handle bad' }]);

    // Its ALERT_RAISED is delivered by the next drain; nothing else is raised afterwards.
    await repo.outbox.add(event('later'));
    for (let i = 0; i < 3; i += 1) await relay.drain();
    expect(seen).toEqual(['good', 'later']);
    expect(alerts).toEqual(['OUTBOX_EVENT_DEAD']);
    expect(await repo.alerts.list()).toHaveLength(1);
  });

  it('60 dead events do not block a live one (the window skips them)', async () => {
    const repo = new InMemoryBulkMailerRepository();
    const { relay, seen } = failing(repo, (e) => e.eventId.startsWith('dead'));
    for (let i = 0; i < 60; i += 1) await repo.outbox.add(event(`dead-${i}`));
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS * 2; i += 1) await relay.drain();
    expect(await repo.outbox.listDead(500)).toHaveLength(60);
    await repo.outbox.add(event('live'));
    await relay.drain();
    expect(seen).toEqual(['live']);
  });

  it('a poisoned ALERT_RAISED event dies without raising another alert', async () => {
    const repo = new InMemoryBulkMailerRepository();
    const bus = new InProcessEventBus();
    bus.subscribe('ALERT_RAISED', async () => {
      throw new Error('notifier down');
    });
    const logged: string[] = [];
    const relay = new OutboxRelay(repo, bus, new FixedClock(), { logger: { error: (m) => void logged.push(m) } });
    await repo.outbox.add({ ...event('alert-1'), type: 'ALERT_RAISED' });
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 5; i += 1) await relay.drain();
    expect(await repo.alerts.list()).toEqual([]);
    expect((await repo.outbox.listDead(10)).map((d) => d.event.eventId)).toEqual(['alert-1']);
    expect(await repo.transaction((tx) => tx.outbox.lockPending(10))).toEqual([]);
    expect(logged).toEqual([expect.stringContaining('Outbox event alert-1 is dead')]);
  });

  it('retrying a dead event makes it pending again from zero attempts, audited', async () => {
    const repo = new InMemoryBulkMailerRepository();
    let down = true;
    const { relay, seen } = failing(repo, () => down);
    await repo.outbox.add(event('a'));
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i += 1) await relay.drain();
    const retry = new RetryDeadEvent({ repository: repo, clock: new FixedClock(), newId: () => 'au-1' });
    expect(await retry.execute('operador', 'nope')).toEqual({ ok: false, error: 'OUTBOX_EVENT_NOT_DEAD' });
    down = false;
    expect(await retry.execute('operador', 'a', ' consumer fixed ')).toEqual({ ok: true, value: { eventId: 'a' } });
    expect((await repo.audit.list()).at(-1)).toMatchObject({ action: 'OUTBOX_EVENT_RETRIED', actor: 'operador', subject: 'a', note: 'consumer fixed' });
    expect(await new ListDeadEvents({ repository: repo, clock: new FixedClock(), newId: () => 'x' }).execute()).toEqual([]);
    await relay.drain();
    expect(seen).toEqual(['a']);
    expect(await retry.execute('operador', 'a')).toEqual({ ok: false, error: 'OUTBOX_EVENT_NOT_DEAD' });
  });
});
