import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
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

/** Marks a row delivered (or permanently failed when slackTs is null). */
export function markDone(tx: Tx, id: number, slackTs: string | null, at: number): void {
  tx.update(schema.outbox).set({ doneAt: at, slackTs }).where(eq(schema.outbox.id, id)).run();
}

/** Schedules the next attempt and counts this one. */
export function markRetry(tx: Tx, id: number, nextAttemptAt: number): void {
  tx.update(schema.outbox)
    .set({ nextAttemptAt, attempts: sql`${schema.outbox.attempts} + 1` })
    .where(eq(schema.outbox.id, id))
    .run();
}

/** Pushes a held row forward without counting an attempt (the cause is ours, not Slack's). */
export function markHeld(tx: Tx, id: number, nextAttemptAt: number): void {
  tx.update(schema.outbox).set({ nextAttemptAt }).where(eq(schema.outbox.id, id)).run();
}
