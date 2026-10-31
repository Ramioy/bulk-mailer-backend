import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresBulkMailerRepository } from '../../src/adapters/outbound/postgres/postgres-bulk-mailer-repository';
import { PostgresJobQueue } from '../../src/adapters/outbound/postgres/postgres-job-queue';
import { bulkMailerRepositoryContract } from '../contracts/bulk-mailer-repository.contract';
import { jobQueueContract } from '../contracts/job-queue.contract';
import { aReceipt, anExecution, T0 } from '../support/builders';
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

    it('lets exactly one of several concurrent executions start', async () => {
      const started = await Promise.all(
        ['e1', 'e2', 'e3', 'e4'].map((executionId) => repo.executions.tryStart(anExecution({ executionId }))),
      );
      expect(started.filter(Boolean)).toHaveLength(1);
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
