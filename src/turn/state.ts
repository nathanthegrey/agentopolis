// Everything an agent may read about itself, gathered by the daemon into the turn prompt
// (spec section 6): nothing an agent could read about itself is a tool, because every tool call
// is one more full-context API request. All of it is derived from rows, never from a flag.
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Snapshot } from "../config/loader.js";
import type { Db } from "../store/db.js";
import type { Message } from "../store/messages.js";
import { pendingFor } from "../store/messages.js";
import * as schema from "../store/schema.js";
import type { TurnPromptInput, TurnState } from "./prompt.js";

export type TurnInput = TurnPromptInput & {
  /** the messages this turn consumes: recorded in turn_messages before the spawn */
  messageIds: number[];
  /** the request rows whose outcome this turn carries */
  requestIds: number[];
  /** the permission rows whose outcome this turn carries */
  permissionIds: number[];
};

/** Container names the agent belongs to, in id order, as the envelope must name them. */
export function containersOf(db: Db, agent: string): { id: number; name: string }[] {
  return db.orm
    .select()
    .from(schema.containers)
    .where(isNull(schema.containers.closedAt))
    .all()
    .filter((c) => c.members.includes(agent))
    .map((c) => ({ id: c.id, name: c.name ?? `container:${c.id}` }));
}

/** Derived, never a flag a crash could leave set (spec section 5). */
export function openAsksToOwner(db: Db, agent: string): number {
  return (
    db.orm
      .select({ n: sql<number>`count(*)` })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.author, agent),
          eq(schema.messages.kind, "ask"),
          eq(schema.messages.to, "owner"),
          isNull(schema.messages.answeredBy),
        ),
      )
      .get()?.n ?? 0
  );
}

const turnIdsOf = (db: Db, agent: string): number[] =>
  db.orm
    .select({ id: schema.turns.id })
    .from(schema.turns)
    .where(eq(schema.turns.agent, agent))
    .all()
    .map((t) => t.id);

export function lastFinishedTurn(db: Db, agent: string) {
  return db.orm
    .select()
    .from(schema.turns)
    .where(and(eq(schema.turns.agent, agent), ne(schema.turns.status, "running")))
    .orderBy(desc(schema.turns.id))
    .get();
}

/** Requests and permissions decided but not yet carried into a prompt. */
export function outcomesFor(
  db: Db,
  agent: string,
): { lines: string[]; requestIds: number[]; permissionIds: number[] } {
  const lines: string[] = [];
  const requestIds: number[] = [];
  const permissionIds: number[] = [];

  for (const r of db.orm
    .select()
    .from(schema.requests)
    .where(
      and(
        eq(schema.requests.agent, agent),
        ne(schema.requests.status, "pending"),
        isNull(schema.requests.toldAt),
      ),
    )
    .all()) {
    requestIds.push(r.id);
    const by = r.decidedBy ? ` da ${r.decidedBy}` : "";
    lines.push(`richiesta #${r.id} (${r.kind}): ${r.status}${by}`);
  }

  const mine = turnIdsOf(db, agent);
  if (mine.length > 0) {
    for (const p of db.orm
      .select()
      .from(schema.permissionRequests)
      .where(
        and(
          inArray(schema.permissionRequests.turnId, mine),
          ne(schema.permissionRequests.status, "pending"),
          isNull(schema.permissionRequests.toldAt),
        ),
      )
      .all()) {
      permissionIds.push(p.id);
      const scope = p.scope === "task" ? ", per tutto il compito" : "";
      lines.push(`permesso #${p.id} (${p.toolName}): ${p.status}${scope}`);
    }
  }
  return { lines, requestIds, permissionIds };
}

function pendingItems(db: Db, agent: string): TurnState["pending"] {
  const items: TurnState["pending"] = [];
  for (const r of db.orm
    .select()
    .from(schema.requests)
    .where(and(eq(schema.requests.agent, agent), eq(schema.requests.status, "pending")))
    .all()) {
    items.push({ what: "richiesta", id: r.id, detail: `${r.kind}, in attesa` });
  }
  const mine = turnIdsOf(db, agent);
  if (mine.length > 0) {
    for (const p of db.orm
      .select()
      .from(schema.permissionRequests)
      .where(
        and(
          inArray(schema.permissionRequests.turnId, mine),
          eq(schema.permissionRequests.status, "pending"),
        ),
      )
      .all()) {
      items.push({ what: "permesso", id: p.id, detail: `${p.toolName}, parcheggiato` });
    }
  }
  return items;
}

/** The remember lines applied since this session started (spec section 6). */
export function rememberedSince(db: Db, agent: string, since: number | null): string[] {
  if (since === null) return [];
  return db.orm
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.kind, "memory.appended"), eq(schema.events.agent, agent)))
    .all()
    .filter((e) => e.at >= since)
    .flatMap((e) => (e.payload as { lines?: string[] }).lines ?? []);
}

export function collectTurnInput(
  db: Db,
  snapshot: Snapshot,
  agent: string,
  rung: { model: string; effort: string | undefined },
): TurnInput {
  const row = db.orm.select().from(schema.agents).where(eq(schema.agents.name, agent)).get();
  const file = snapshot.agents.get(agent);
  const roleName = file?.role ?? row?.role ?? "";
  const containers = containersOf(db, agent);
  const byId = new Map(containers.map((c) => [c.id, c.name]));

  const pending: Message[] = pendingFor(db, agent);
  const last = lastFinishedTurn(db, agent);
  const outcomes = outcomesFor(db, agent);

  const state: TurnState = {
    agent,
    role: roleName,
    model: rung.model,
    effort: rung.effort,
    containers: containers.map((c) => c.name),
    openAsks: openAsksToOwner(db, agent),
    pending: pendingItems(db, agent),
    lastCostMicro: last?.costMicrousd ?? null,
    cacheHitRatio:
      last && last.cacheRead !== null && last.cacheRead > 0 && last.cacheCreation !== null
        ? last.cacheRead / (last.cacheRead + last.cacheCreation)
        : null,
  };

  return {
    state,
    messages: pending.map((m) => ({
      id: m.id,
      container: byId.get(m.containerId) ?? `container:${m.containerId}`,
      author: m.author,
      kind: m.kind,
      body: m.body,
    })),
    outcomes: outcomes.lines,
    remembered: rememberedSince(
      db,
      agent,
      row?.sessionStartedAt ?? file?.session_started_at ?? null,
    ),
    messageIds: pending.map((m) => m.id),
    requestIds: outcomes.requestIds,
    permissionIds: outcomes.permissionIds,
  };
}

/** Pending messages, or an outcome the agent has not been told about yet. */
export function hasWork(db: Db, agent: string): boolean {
  if (pendingFor(db, agent).length > 0) return true;
  const o = outcomesFor(db, agent);
  return o.requestIds.length > 0 || o.permissionIds.length > 0;
}

/** Marks the outcomes this turn carries, so they are told exactly once. */
export function markOutcomesTold(
  db: Db,
  at: number,
  requestIds: number[],
  permissionIds: number[],
): void {
  if (requestIds.length > 0) {
    db.orm
      .update(schema.requests)
      .set({ toldAt: at })
      .where(and(inArray(schema.requests.id, requestIds), isNull(schema.requests.toldAt)))
      .run();
  }
  if (permissionIds.length > 0) {
    db.orm
      .update(schema.permissionRequests)
      .set({ toldAt: at })
      .where(
        and(
          inArray(schema.permissionRequests.id, permissionIds),
          isNull(schema.permissionRequests.toldAt),
        ),
      )
      .run();
  }
}
