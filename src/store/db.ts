import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = {
  sqlite: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
  close(): void;
};

const MIGRATIONS = fileURLToPath(new URL("../../drizzle/", import.meta.url));

export function openDatabase(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = FULL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const orm = drizzle(sqlite, { schema });
  migrate(orm, { migrationsFolder: MIGRATIONS });
  return { sqlite, orm, close: () => sqlite.close() };
}
