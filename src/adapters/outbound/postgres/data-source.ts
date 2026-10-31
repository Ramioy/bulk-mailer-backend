import { DataSource } from 'typeorm';

import { InitialSchema1761868800000 } from './migrations/1761868800000-initial-schema';
import { OperatorAccounts1761872400000 } from './migrations/1761872400000-operator-accounts';
import { ExecutionEvents1761876000000 } from './migrations/1761876000000-execution-events';

export const MIGRATIONS = [InitialSchema1761868800000, OperatorAccounts1761872400000, ExecutionEvents1761876000000];

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
