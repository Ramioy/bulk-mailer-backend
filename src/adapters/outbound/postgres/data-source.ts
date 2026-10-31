import { DataSource } from 'typeorm';

import { InitialSchema1761868800000 } from './migrations/1761868800000-initial-schema';
import { OperatorAccounts1761872400000 } from './migrations/1761872400000-operator-accounts';
import { ExecutionEvents1761876000000 } from './migrations/1761876000000-execution-events';
import { Outbox1761879600000 } from './migrations/1761879600000-outbox';
import { DeliveryTracking1761883200000 } from './migrations/1761883200000-delivery-tracking';
import { ProcessFailed1761890400000 } from './migrations/1761890400000-process-failed';
import { DuplicateConflicts1761894000000 } from './migrations/1761894000000-duplicate-conflicts';

export const MIGRATIONS = [InitialSchema1761868800000, OperatorAccounts1761872400000, ExecutionEvents1761876000000, Outbox1761879600000, DeliveryTracking1761883200000, ProcessFailed1761890400000, DuplicateConflicts1761894000000];

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
