import { access, constants } from 'node:fs/promises';

import type { DataSource } from 'typeorm';

import type { ReadinessProbe } from '../../../ports/readiness-probe';

/** D50 (B8): `SELECT 1` on the database and read/write access to the receipts volume. */
export class SystemReadinessProbe implements ReadinessProbe {
  constructor(
    private readonly dataSource: DataSource,
    private readonly dataDir: string,
  ) {}

  async check(): Promise<Readonly<Record<string, boolean>>> {
    const [database, volume] = await Promise.all([
      this.dataSource.query('SELECT 1').then(
        () => true,
        () => false,
      ),
      access(this.dataDir, constants.R_OK | constants.W_OK).then(
        () => true,
        () => false,
      ),
    ]);
    return { database, volume };
  }
}
