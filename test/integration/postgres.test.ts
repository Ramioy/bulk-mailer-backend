import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LocalJwtAuthenticator } from '../../src/adapters/outbound/auth/local-jwt-authenticator';
import { hashPassword } from '../../src/adapters/outbound/auth/password-hasher';
import { PostgresOperatorAccountStore } from '../../src/adapters/outbound/auth/postgres-operator-account-store';
import { FixedClock } from '../../src/adapters/outbound/fakes/fixed-clock';
import { OutboxRelay } from '../../src/application/events/outbox-relay';
import { PostgresBulkMailerRepository } from '../../src/adapters/outbound/postgres/postgres-bulk-mailer-repository';
import { PostgresJobQueue } from '../../src/adapters/outbound/postgres/postgres-job-queue';
import { bulkMailerRepositoryContract } from '../contracts/bulk-mailer-repository.contract';
import { jobQueueContract, transactionalJobsContract } from '../contracts/job-queue.contract';
import type { Receipt } from '../../src/domain/receipt/receipt';
import { ConcurrentModificationError } from '../../src/ports/bulk-mailer-repository';
import { aReceipt, anExecution, hashOf, T0 } from '../support/builders';
import { gate } from '../support/serial-guard';
import { migratedDataSource, resetData, TEST_DATABASE_URL } from '../support/postgres';

describe.skipIf(!TEST_DATABASE_URL)('PostgreSQL 18', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await migratedDataSource(TEST_DATABASE_URL as string);
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  bulkMailerRepositoryContract('postgres', async () => {
    await resetData(dataSource);
    return new PostgresBulkMailerRepository(dataSource);
  });

  jobQueueContract('postgres', async () => {
    await resetData(dataSource);
    return new PostgresJobQueue(dataSource);
  });

  transactionalJobsContract('postgres', async () => {
    await resetData(dataSource);
    return { repository: new PostgresBulkMailerRepository(dataSource), queue: new PostgresJobQueue(dataSource) };
  });

  describe('storage-level guarantees', () => {
    let repo: PostgresBulkMailerRepository;

    beforeEach(async () => {
      await resetData(dataSource);
      repo = new PostgresBulkMailerRepository(dataSource);
    });

    it('refuses to update, delete or truncate audit entries (AUDIT_IMMUTABLE)', async () => {
      await repo.audit.append({ auditId: 'au1', actor: 'op', action: 'SIGN_IN', at: T0, subject: 'op' });
      await expect(dataSource.query(`UPDATE audit_entries SET actor = 'x'`)).rejects.toThrow('AUDIT_IMMUTABLE');
      await expect(dataSource.query('DELETE FROM audit_entries')).rejects.toThrow('AUDIT_IMMUTABLE');
      await expect(dataSource.query('TRUNCATE audit_entries')).rejects.toThrow('AUDIT_IMMUTABLE');
      expect(await repo.audit.list()).toHaveLength(1);
    });

    it('rejects states and blocks that do not exist', async () => {
      await expect(repo.receipts.save(aReceipt({ state: 'LOST' as never }))).rejects.toThrow('receipts_state_check');
      await expect(repo.receipts.save(aReceipt({ block: 'EFECTIVO' as never }))).rejects.toThrow('receipts_block_check');
    });

    it('D37: of two transactions that read the same receipt version, the second save fails (row lock + version)', async () => {
      await repo.receipts.save(aReceipt());
      const firstSaved = gate();
      const commitFirst = gate();
      const first = repo.transaction(async (tx) => {
        const read = (await tx.receipts.get(hashOf('a'))) as Receipt;
        await tx.receipts.save({ ...read, state: 'SENDING' });
        firstSaved.open();
        await commitFirst.wait;
      });
      await firstSaved.wait;
      const second = repo.transaction(async (tx) => {
        // Reads version 1: the first transaction has not committed yet.
        const read = (await tx.receipts.get(hashOf('a'))) as Receipt;
        const saving = tx.receipts.save({ ...read, state: 'REMOVED' });
        commitFirst.open();
        return saving;
      });
      await first;
      await expect(second).rejects.toBeInstanceOf(ConcurrentModificationError);
      expect(await repo.receipts.get(hashOf('a'))).toMatchObject({ state: 'SENDING', version: 2 });
    });

    it('lets exactly one of several concurrent executions start', async () => {
      const started = await Promise.all(
        ['e1', 'e2', 'e3', 'e4'].map((executionId) => repo.executions.tryStart(anExecution({ executionId }))),
      );
      expect(started.filter(Boolean)).toHaveLength(1);
    });

    it('authenticates against operator accounts and sessions stored in PostgreSQL', async () => {
      await dataSource.query('INSERT INTO operator_accounts (operator_id, username, password_hash) VALUES ($1, $2, $3)', [
        'op-1', 'operador', await hashPassword('correct horse battery staple'),
      ]);
      const clock = new FixedClock();
      const auth = new LocalJwtAuthenticator(new PostgresOperatorAccountStore(dataSource), clock, {
        signingKey: Buffer.alloc(32, 3), accessTokenMinutes: 15, sessionHours: 8,
      });
      expect(await auth.signIn('nadie', 'x')).toEqual({ ok: false, error: 'UNKNOWN_USER' });
      const signedIn = await auth.signIn('operador', 'correct horse battery staple');
      if (!signedIn.ok) throw new Error('sign-in failed');
      const { accessToken, refreshToken } = signedIn.value.tokens;
      expect((await auth.verify(accessToken)).ok).toBe(true);

      const renewed = await auth.refresh(refreshToken);
      expect(renewed.ok).toBe(true);
      expect((await auth.refresh(refreshToken)).ok).toBe(false);

      if (!renewed.ok) throw new Error('refresh failed');
      expect(await auth.signOut(renewed.value.tokens.refreshToken)).toEqual({ operatorId: 'op-1', username: 'operador' });
      expect((await auth.verify(accessToken)).ok).toBe(false);
    });

    it('refuses an account whose password is not an argon2id hash', async () => {
      await expect(
        dataSource.query(`INSERT INTO operator_accounts (operator_id, username, password_hash) VALUES ('x', 'x', 'plain')`),
      ).rejects.toThrow('operator_accounts_password_hash_check');
    });

    it('two concurrent relays never deliver the same outbox event twice', async () => {
      for (let i = 0; i < 6; i += 1) {
        await repo.outbox.add({ eventId: `ev${i}`, type: 'RECEIPT_SENT', occurredAt: T0, payload: { i } });
      }
      const delivered: string[] = [];
      const bus = { publish: async (e: { eventId: string }) => void delivered.push(e.eventId) };
      const relays = [1, 2, 3].map(() => new OutboxRelay(repo, bus, new FixedClock(), 2));
      await Promise.all(relays.map((r) => r.drain()));
      await Promise.all(relays.map((r) => r.drain()));
      expect(delivered.sort()).toEqual(['ev0', 'ev1', 'ev2', 'ev3', 'ev4', 'ev5']);
    });

    it('never hands the same job to two concurrent runners (SKIP LOCKED)', async () => {
      const queue = new PostgresJobQueue(dataSource);
      for (let i = 0; i < 5; i += 1) await queue.enqueue({ type: 'RECONCILE_ATTEMPT', payload: { i }, runAt: T0 });
      const claimed = await Promise.all(Array.from({ length: 8 }, () => queue.claimNext(T0)));
      const ids = claimed.filter((j) => j !== undefined).map((j) => j.jobId);
      expect(ids).toHaveLength(5);
      expect(new Set(ids).size).toBe(5);
    });
  });
});
