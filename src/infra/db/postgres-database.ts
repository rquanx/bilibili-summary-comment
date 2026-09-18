import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, types as pgTypes } from "pg";
import type { PoolClient, QueryResultRow } from "pg";

pgTypes.setTypeParser(20, (value) => Number(value));

export interface PostgresDb {
  readonly kind: "postgres";
  readonly connectionString: string;
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<T[]>;
  execute(text: string, values?: unknown[]): Promise<number>;
  transaction<T>(work: () => Promise<T> | T): Promise<T>;
  track<T>(work: Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function isPostgresDatabase(db: unknown): db is PostgresDb {
  return Boolean(db && typeof db === "object" && (db as { kind?: unknown }).kind === "postgres");
}

export function openPostgresDatabase(connectionString: string): PostgresDb {
  const pool = new Pool({
    connectionString,
    max: resolvePoolSize(process.env.POSTGRES_POOL_SIZE),
    allowExitOnIdle: true,
  });
  const transactionStorage = new AsyncLocalStorage<PoolClient>();
  const pending = new Set<Promise<unknown>>();

  async function query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    const activeClient = transactionStorage.getStore();
    const result = activeClient
      ? await activeClient.query<T>(text, values)
      : await pool.query<T>(text, values);
    return result.rows;
  }

  async function execute(text: string, values: unknown[] = []): Promise<number> {
    const activeClient = transactionStorage.getStore();
    const result = activeClient
      ? await activeClient.query(text, values)
      : await pool.query(text, values);
    return result.rowCount ?? 0;
  }

  async function transaction<T>(work: () => Promise<T> | T): Promise<T> {
    const existingClient = transactionStorage.getStore();
    if (existingClient) {
      return await work();
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await transactionStorage.run(client, work);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.finally(() => {
      pending.delete(work);
    });
    return work;
  }

  async function close() {
    if (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
    await pool.end();
  }

  return {
    kind: "postgres",
    connectionString,
    query,
    execute,
    transaction,
    track,
    close,
  };
}

function resolvePoolSize(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10;
  }
  return Math.max(1, Math.min(50, Math.floor(parsed)));
}
