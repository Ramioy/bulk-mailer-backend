import { describe, expect, it } from 'vitest';

import { InProcessEventBus } from '../../src/adapters/outbound/events/in-process-event-bus';
import { FixedClock } from '../../src/adapters/outbound/fakes/fixed-clock';
import { InMemoryBulkMailerRepository } from '../../src/adapters/outbound/in-memory/in-memory-bulk-mailer-repository';
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
    expect(await repo.transaction((tx) => tx.outbox.lockPending(10))).toEqual([{ event: { ...event('x'), type: 'ALERT_RAISED' }, attempts: MAX_DELIVERY_ATTEMPTS }]);
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
