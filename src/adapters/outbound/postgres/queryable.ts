import type { DataSource, QueryRunner } from 'typeorm';

export type Row = Record<string, unknown>;

/** Runs SQL either with autocommit or inside the transaction of a QueryRunner. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<Row[]>;
}

export function inTransaction(runner: QueryRunner): Queryable {
  return { query: async (sql, params = []) => (await runner.query(sql, params, true)).records as Row[] };
}

export function autocommit(dataSource: DataSource): Queryable {
  return {
    query: async (sql, params = []) => {
      const runner = dataSource.createQueryRunner();
      try {
        return (await runner.query(sql, params, true)).records as Row[];
      } finally {
        await runner.release();
      }
    },
  };
}

export async function rows(db: Queryable, sql: string, params: unknown[] = []): Promise<Row[]> {
  return db.query(sql, params);
}

export async function firstRow(db: Queryable, sql: string, params: unknown[] = []): Promise<Row | undefined> {
  return (await db.query(sql, params))[0];
}

const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  const e = error as { driverError?: { code?: string }; code?: string } | undefined;
  return (e?.driverError?.code ?? e?.code) === UNIQUE_VIOLATION;
}

/** Maps SQL NULL to an absent optional property. */
export function opt<T>(value: unknown): T | undefined {
  return value === null || value === undefined ? undefined : (value as T);
}
