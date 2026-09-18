import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/store/db.js";

describe("openDatabase", () => {
  it("opens with WAL, synchronous=FULL and a busy timeout, and applies migrations", () => {
    const file = join(mkdtempSync(join(tmpdir(), "db-")), "a.db");
    const db = openDatabase(file);
    expect(db.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.sqlite.pragma("synchronous", { simple: true })).toBe(2); // 2 = FULL
    expect(db.sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
    const tables = db.sqlite
      .prepare(
        "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '__drizzle%'",
      )
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(tables).toEqual([
      "agents",
      "containers",
      "events",
      "inbox",
      "messages",
      "outbox",
      "permission_requests",
      "renders",
      "requests",
      "schedules",
      "tasks",
      "turn_messages",
      "turns",
    ]);
    db.close();
  });
  it("has a partial outbox index and a descending turns index", () => {
    const file = join(mkdtempSync(join(tmpdir(), "db-")), "a.db");
    const db = openDatabase(file);
    const indexSql = (name: string) =>
      (
        db.sqlite
          .prepare("select sql from sqlite_master where type='index' and name=?")
          .get(name) as { sql: string } | undefined
      )?.sql ?? "";
    expect(indexSql("outbox_next_attempt")).toMatch(/where\s+done_at\s+is\s+null/i);
    expect(indexSql("turns_agent_started")).toMatch(/started_at.*desc/i);
    db.close();
  });
  it("is idempotent: opening twice applies nothing new", () => {
    const file = join(mkdtempSync(join(tmpdir(), "db-")), "a.db");
    openDatabase(file).close();
    expect(() => openDatabase(file).close()).not.toThrow();
  });
});
