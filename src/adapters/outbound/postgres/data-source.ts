import { DataSource } from 'typeorm';

import { InitialSchema1761868800000 } from './migrations/1761868800000-initial-schema';

export const MIGRATIONS = [InitialSchema1761868800000];

/** TypeORM is used for connections, transactions and migrations; queries are explicit SQL. */
export function createDataSource(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    migrations: MIGRATIONS,
    migrationsTransactionMode: 'each',
    synchronize: false,
    logging: false,
  });
}
