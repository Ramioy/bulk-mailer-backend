import { beforeEach, describe, expect, it } from 'vitest';

import { Period } from '../../src/domain/period/period';
import { DuplicateAttemptError, type BulkMailerRepository } from '../../src/ports/bulk-mailer-repository';
import { aReceipt, anAttempt, anExecution, hashOf, OCT_2026, T0 } from '../support/builders';

/** Behaviour every BulkMailerRepository adapter must have. Run against in-memory now, PostgreSQL in step 3. */
export function bulkMailerRepositoryContract(name: string, create: () => Promise<BulkMailerRepository>): void {
  describe(`BulkMailerRepository contract: ${name}`, () => {
    let repo: BulkMailerRepository;

    beforeEach(async () => {
      repo = await create();
    });

    describe('receipts', () => {
      it('saves, replaces and reads a receipt by hash, keeping every field', async () => {
        const receipt = aReceipt({ errorDetail: 'x', deliveryState: 'UNCONFIRMED' });
        await repo.receipts.save(receipt);
        await repo.receipts.save({ ...receipt, state: 'SENT', attempts: 1 });
        expect(await repo.receipts.get(receipt.sha256)).toEqual({ ...receipt, state: 'SENT', attempts: 1 });
        expect(await repo.receipts.get(hashOf('f'))).toBeUndefined();
      });

      it('lists by batch ordered by file name, and by state', async () => {
        await repo.receipts.save(aReceipt({ sha256: hashOf('a'), fileName: 'b.pdf' }));
        await repo.receipts.save(aReceipt({ sha256: hashOf('b'), fileName: 'a.pdf', state: 'INVALID' }));
        await repo.receipts.save(aReceipt({ sha256: hashOf('c'), block: 'ANGLO' }));
        await repo.receipts.save(aReceipt({ sha256: hashOf('d'), period: Period.of(2026, 9) }));
        expect((await repo.receipts.listByBatch(OCT_2026, 'CASH')).map((r) => r.fileName)).toEqual(['a.pdf', 'b.pdf']);
        expect((await repo.receipts.listByState('INVALID')).map((r) => r.sha256)).toEqual([hashOf('b')]);
      });

      it('keeps the history of a receipt in order', async () => {
        await repo.receipts.save(aReceipt());
        await repo.receipts.appendHistory({ sha256: hashOf('a'), at: T0, event: 'UPLOADED' });
        await repo.receipts.appendHistory({ sha256: hashOf('a'), at: new Date(T0.getTime() + 1), event: 'SENT', detail: 'r1' });
        expect((await repo.receipts.history(hashOf('a'))).map((h) => h.event)).toEqual(['UPLOADED', 'SENT']);
      });
    });

    describe('batches and manifests', () => {
      it('saves a batch and its manifest versions', async () => {
        const batch = { period: OCT_2026, block: 'CASH' as const, state: 'OPEN' as const, manifestVersion: 2, updatedAt: T0 };
        await repo.batches.save(batch);
        expect(await repo.batches.get(OCT_2026, 'CASH')).toEqual(batch);
        expect(await repo.batches.get(OCT_2026, 'ANGLO')).toBeUndefined();

        const manifest = {
          version: 2,
          entries: [{ sha256: hashOf('a'), fileName: 'a.pdf', conceptKey: 'MULTA', contract: '1', email: 'a@x.co' }],
        };
        await repo.batches.saveManifest(OCT_2026, 'CASH', manifest);
        expect(await repo.batches.getManifest(OCT_2026, 'CASH', 2)).toEqual(manifest);
        expect(await repo.batches.getManifest(OCT_2026, 'CASH', 1)).toBeUndefined();
      });
    });

    describe('executions', () => {
      it('allows only one running execution in the whole system', async () => {
        expect(await repo.executions.tryStart(anExecution({ executionId: 'e1' }))).toBe(true);
        expect(await repo.executions.tryStart(anExecution({ executionId: 'e2', block: 'ANGLO' }))).toBe(false);
        expect(await repo.executions.get('e2')).toBeUndefined();
        expect((await repo.executions.running())?.executionId).toBe('e1');

        await repo.executions.save({ ...anExecution({ executionId: 'e1' }), finishedAt: T0, result: 'COMPLETED' });
        expect(await repo.executions.running()).toBeUndefined();
        expect(await repo.executions.tryStart(anExecution({ executionId: 'e2' }))).toBe(true);
      });
    });

    describe('attempts', () => {
      it('inserts once per attempt id and lists by receipt in order', async () => {
        await repo.attempts.insert(anAttempt({ attemptId: 'a2', startedAt: new Date(T0.getTime() + 1000) }));
        await repo.attempts.insert(anAttempt({ attemptId: 'a1' }));
        await expect(repo.attempts.insert(anAttempt({ attemptId: 'a1' }))).rejects.toBeInstanceOf(DuplicateAttemptError);

        await repo.attempts.save({ ...anAttempt({ attemptId: 'a1' }), outcome: 'ACCEPTED', providerRequestId: 'r1', finishedAt: T0 });
        expect(await repo.attempts.get('a1')).toMatchObject({ outcome: 'ACCEPTED', providerRequestId: 'r1' });
        expect((await repo.attempts.listByReceipt(hashOf('a'))).map((a) => a.attemptId)).toEqual(['a1', 'a2']);
      });
    });

    describe('suppressions', () => {
      it('saves, reads and removes an address', async () => {
        await repo.suppressions.save({ email: 'x@y.co', reason: 'HARD_BOUNCE', since: T0 });
        expect(await repo.suppressions.get('x@y.co')).toEqual({ email: 'x@y.co', reason: 'HARD_BOUNCE', since: T0 });
        await repo.suppressions.remove('x@y.co');
        expect(await repo.suppressions.get('x@y.co')).toBeUndefined();
      });
    });

    describe('delivery events', () => {
      it('discards duplicates by event id', async () => {
        const event = {
          eventId: 'w1',
          attemptId: 'a1',
          recipient: 'x@y.co',
          isPrimaryRecipient: true,
          state: 'ACCEPTED' as const,
          occurredAt: T0,
        };
        expect(await repo.deliveryEvents.record(event)).toBe(true);
        expect(await repo.deliveryEvents.record(event)).toBe(false);
        expect(await repo.deliveryEvents.listByAttempt('a1')).toEqual([event]);
      });
    });

    describe('alerts, audit, concepts and settings', () => {
      it('keeps alerts and audit entries in order', async () => {
        await repo.alerts.insert({ alertId: 'al1', type: 'BATCH_STOPPED', subject: 'e1', detail: 'd', raisedAt: T0 });
        expect(await repo.alerts.list()).toHaveLength(1);

        await repo.audit.append({ auditId: 'au1', actor: 'op', action: 'SIGN_IN', at: T0, subject: 'op' });
        await repo.audit.append({ auditId: 'au2', actor: 'op', action: 'ARCHIVE_COPY_CHANGED', at: T0, subject: 'bcc', previousValue: 'false', newValue: 'true', note: 'n' });
        expect((await repo.audit.list()).map((a) => a.auditId)).toEqual(['au1', 'au2']);
      });

      it('starts with the initial concept catalog and saves changes', async () => {
        expect((await repo.concepts.list()).map((c) => c.key).sort()).toEqual(['CUOTA EXTRA', 'MULTA', 'PAGO ADMINISTRACIÓN']);
        await repo.concepts.save({ key: 'MULTA', subject: 'Multa', active: false });
        expect((await repo.concepts.list()).find((c) => c.key === 'MULTA')?.active).toBe(false);
      });

      it('has the archive copy disabled by default', async () => {
        expect(await repo.settings.archiveCopyEnabled()).toBe(false);
        await repo.settings.setArchiveCopyEnabled(true);
        expect(await repo.settings.archiveCopyEnabled()).toBe(true);
      });
    });

    describe('transaction', () => {
      it('keeps every change when the work succeeds', async () => {
        await repo.transaction(async (tx) => {
          await tx.receipts.save(aReceipt());
          await tx.attempts.insert(anAttempt());
        });
        expect(await repo.receipts.get(hashOf('a'))).toBeDefined();
        expect(await repo.attempts.get('attempt-1')).toBeDefined();
      });

      it('discards every change when the work fails', async () => {
        await repo.receipts.save(aReceipt({ state: 'PENDING' }));
        await expect(
          repo.transaction(async (tx) => {
            await tx.receipts.save(aReceipt({ state: 'SENDING' }));
            await tx.attempts.insert(anAttempt());
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        expect((await repo.receipts.get(hashOf('a')))?.state).toBe('PENDING');
        expect(await repo.attempts.get('attempt-1')).toBeUndefined();
      });
    });
  });
}
