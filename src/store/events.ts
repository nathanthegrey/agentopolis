import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

type Tx = BetterSQLite3Database<typeof schema>;

export function appendEvent(
  tx: Tx,
  e: { at: number; kind: string; agent?: string; payload: unknown; traceId?: string },
): number {
  return tx
    .insert(schema.events)
    .values({
      at: e.at,
      kind: e.kind,
      agent: e.agent ?? null,
      payload: e.payload,
      traceId: e.traceId ?? null,
    })
    .returning({ id: schema.events.id })
    .get().id;
}
