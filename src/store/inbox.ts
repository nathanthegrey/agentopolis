import { and, eq, gte } from "drizzle-orm";
import type { Clock } from "../ports/clock.js";
import type { Db } from "./db.js";
import * as schema from "./schema.js";

const DAY = 86_400_000;

export function recordInbound(
  db: Db,
  clock: Clock,
  e: { eventId: string; logicalKey?: string; payload: unknown },
): { inserted: boolean; id: number } {
  return db.orm.transaction((tx) => {
    const now = clock.now();
    const byEvent = tx
      .select({ id: schema.inbox.id })
      .from(schema.inbox)
      .where(eq(schema.inbox.eventId, e.eventId))
      .get();
    if (byEvent) return { inserted: false, id: byEvent.id };
    if (e.logicalKey) {
      const byKey = tx
        .select({ id: schema.inbox.id })
        .from(schema.inbox)
        .where(
          and(eq(schema.inbox.logicalKey, e.logicalKey), gte(schema.inbox.receivedAt, now - DAY)),
        )
        .get();
      if (byKey) return { inserted: false, id: byKey.id };
    }
    const id = tx
      .insert(schema.inbox)
      .values({
        eventId: e.eventId,
        logicalKey: e.logicalKey ?? null,
        payload: e.payload,
        receivedAt: now,
      })
      .returning({ id: schema.inbox.id })
      .get().id;
    return { inserted: true, id };
  });
}
