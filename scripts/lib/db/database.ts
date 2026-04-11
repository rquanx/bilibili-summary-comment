import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "./migrations";

export function openDatabase(databasePath: string): DatabaseSync {
  const resolvedPath = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const db = new DatabaseSync(resolvedPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrateDatabase(db);
  return db;
}
