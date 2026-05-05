import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Db, DrizzleDb } from "./types";
import * as schema from "./schema";

const DRIZZLE_DB_SYMBOL = Symbol.for("video-pipeline.drizzleDb");

type DbWithDrizzle = Db & {
  [DRIZZLE_DB_SYMBOL]?: DrizzleDb;
};

export function initializeDrizzleDb(db: Db): DrizzleDb {
  const existing = (db as DbWithDrizzle)[DRIZZLE_DB_SYMBOL];
  if (existing) {
    return existing;
  }

  const orm = drizzle(db, { schema });
  Object.defineProperty(db, DRIZZLE_DB_SYMBOL, {
    value: orm,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return orm;
}

export function getDrizzleDb(db: Db): DrizzleDb {
  const orm = (db as DbWithDrizzle)[DRIZZLE_DB_SYMBOL];
  if (!orm) {
    throw new Error("Drizzle database is not initialized. Use openDatabase() to create the connection.");
  }

  return orm;
}
