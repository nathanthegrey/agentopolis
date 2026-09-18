import { and, asc, isNull, lte } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Clock } from "../ports/clock.js";
import type { Db } from "./db.js";
import * as schema from "./schema.js";

type Tx = BetterSQLite3Database<typeof schema>;

export type OutboxRow = typeof schema.outbox.$inferSelect;

export function enqueueOutbox(
  tx: Tx,
  clock: Clock,
  row: { kind: string; channel: string; payload: unknown },
): number {
  const now = clock.now();
  return tx
    .insert(schema.outbox)
    .values({
      kind: row.kind,
      channel: row.channel,
      payload: row.payload,
      nextAttemptAt: now,
      createdAt: now,
    })
    .returning({ id: schema.outbox.id })
    .get().id;
}

export function nextOutbox(db: Db, now: number, limit: number): OutboxRow[] {
  return db.orm
    .select()
    .from(schema.outbox)
    .where(and(isNull(schema.outbox.doneAt), lte(schema.outbox.nextAttemptAt, now)))
    .orderBy(asc(schema.outbox.nextAttemptAt), asc(schema.outbox.id))
    .limit(limit)
    .all();
}
