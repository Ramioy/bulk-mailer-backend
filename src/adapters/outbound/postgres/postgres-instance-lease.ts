import type { DataSource } from 'typeorm';

import type { InstanceLease, LeaseState } from '../../../ports/instance-lease';
import { autocommit, firstRow, rows, type Queryable } from './queryable';

/**
 * D47: a single-row table judged by the database clock. Each statement is atomic, so two instances can never both
 * take it. A row lock or an advisory lock was not used: an advisory lock belongs to a connection, and the pool hands
 * connections to anyone; the row also survives a dropped connection until its expiry, which is what makes the TTL safe.
 */
export class PostgresInstanceLease implements InstanceLease {
  private readonly db: Queryable;

  constructor(dataSource: DataSource) {
    this.db = autocommit(dataSource);
  }

  async acquire(instanceId: string, ttlSeconds: number): Promise<boolean> {
    const taken = await rows(
      this.db,
      `INSERT INTO instance_lease (id, holder, expires_at) VALUES (1, $1, now() + make_interval(secs => $2))
       ON CONFLICT (id) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
       WHERE instance_lease.expires_at <= now() OR instance_lease.holder = EXCLUDED.holder
       RETURNING holder`,
      [instanceId, ttlSeconds],
    );
    return taken.length === 1;
  }

  async renew(instanceId: string, ttlSeconds: number): Promise<boolean> {
    const renewed = await rows(
      this.db,
      `UPDATE instance_lease SET expires_at = now() + make_interval(secs => $2)
       WHERE id = 1 AND holder = $1 AND expires_at > now() RETURNING holder`,
      [instanceId, ttlSeconds],
    );
    return renewed.length === 1;
  }

  async release(instanceId: string): Promise<void> {
    await this.db.query(`UPDATE instance_lease SET expires_at = now() - interval '1 second' WHERE id = 1 AND holder = $1`, [instanceId]);
  }

  async current(): Promise<LeaseState | undefined> {
    const r = await firstRow(this.db, 'SELECT holder, expires_at, expires_at > now() AS live FROM instance_lease WHERE id = 1');
    return r && { holder: r.holder as string, expiresAt: r.expires_at as Date, live: r.live as boolean };
  }
}
