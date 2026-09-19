import { and, asc, eq, notExists } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Clock } from "../ports/clock.js";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { enqueueOutbox } from "./outbox.js";
import * as schema from "./schema.js";

type Tx = BetterSQLite3Database<typeof schema>;

export type MessageKind = "say" | "ask" | "report" | "system";
export type Message = typeof schema.messages.$inferSelect;
export type NewMessage = {
  containerId: number;
  author: string;
  to: string;
  body: string;
  kind: MessageKind;
  testsGreen?: boolean | undefined;
};

export function appendMessage(
  db: Db,
  clock: Clock,
  m: NewMessage,
): { messageId: number; eventId: number } {
  return db.orm.transaction((tx) => appendMessageTx(tx, clock, m));
}

/** The same append inside a transaction the caller already owns (envelope delivery). */
export function appendMessageTx(
  tx: Tx,
  clock: Clock,
  m: NewMessage,
): { messageId: number; eventId: number } {
  const container = tx
    .select()
    .from(schema.containers)
    .where(eq(schema.containers.id, m.containerId))
    .get();
  if (!container) throw new Error(`appendMessage: container ${m.containerId} does not exist`);
  const now = clock.now();
  const messageId = tx
    .insert(schema.messages)
    .values({
      containerId: m.containerId,
      author: m.author,
      to: m.to,
      body: m.body,
      kind: m.kind,
      createdAt: now,
      testsGreen: m.testsGreen ?? null,
    })
    .returning({ id: schema.messages.id })
    .get().id;
  const eventId = appendEvent(tx, {
    at: now,
    kind: "message.posted",
    agent: m.author,
    payload: { messageId, to: m.to, kind: m.kind },
  });
  enqueueOutbox(tx, clock, {
    kind: "mirror.message",
    channel: container.slackChannel ?? "",
    payload: { messageId },
  });
  return { messageId, eventId };
}

export function pendingFor(db: Db, agent: string): Message[] {
  const delivered = db.orm
    .select({ id: schema.turnMessages.messageId })
    .from(schema.turnMessages)
    .where(eq(schema.turnMessages.messageId, schema.messages.id));
  return db.orm
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.to, agent), notExists(delivered)))
    .orderBy(asc(schema.messages.id))
    .all();
}

export function recordDelivery(db: Db, turnId: number, messageIds: number[]): void {
  if (messageIds.length === 0) return;
  db.orm.transaction((tx) => {
    tx.insert(schema.turnMessages)
      .values(messageIds.map((messageId) => ({ turnId, messageId })))
      .run();
  });
}
