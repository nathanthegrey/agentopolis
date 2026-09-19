// Tier 3 of spec section 10: what an agent may ask the daemon to do, and what needs the owner's
// button first. Three kinds in v1 (spec section 8); the daemon refuses the rest and says why.
import { eq } from "drizzle-orm";
import type { SnapshotHolder } from "../config/holder.js";
import type { Clock } from "../ports/clock.js";
import type { Db } from "../store/db.js";
import { appendEvent } from "../store/events.js";
import * as schema from "../store/schema.js";
import { renderApprovalCard, renderPayload, rewriteCard } from "./cards.js";

export const REQUEST_KINDS = ["open_task", "close_task", "merge_production"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** The presets the lead sees on the task card (A1). */
export const PRESETS: Record<string, { model: string; effort: string }> = {
  piccolo: { model: "sonnet", effort: "medium" },
  normale: { model: "sonnet", effort: "high" },
  difficile: { model: "opus", effort: "high" },
};

const ROLE_FOR_TASK_KIND: Record<string, string> = {
  develop: "developer",
  review: "reviewer",
  design: "designer",
};

export type RequestOutcome =
  | { ok: true; id: number; status: "approved" | "pending"; message: string }
  | { ok: false; message: string };

export type ApprovalsDeps = {
  db: Db;
  clock: Clock;
  holder: SnapshotHolder;
  channelFor(agent: string): string;
  wakeAgent(agent: string, reason: string): void;
  /** slice 6 opens the task; here it only records the intent */
  onApproved?(requestId: number, kind: string, agent: string, payload: unknown): void;
};

export class Approvals {
  readonly #deps: ApprovalsDeps;

  constructor(deps: ApprovalsDeps) {
    this.#deps = deps;
  }

  /** An agent's request(kind, payload), arriving over the MCP socket. */
  request(agent: string, kind: string, payload: Record<string, unknown>): RequestOutcome {
    const { db, clock, holder } = this.#deps;
    const snapshot = holder.current;
    const row = db.orm.select().from(schema.agents).where(eq(schema.agents.name, agent)).get();
    const role = snapshot.roles.get(snapshot.agents.get(agent)?.role ?? row?.role ?? "");
    if (!role) return { ok: false, message: `non conosco l'agente ${agent}` };
    if (!REQUEST_KINDS.includes(kind as RequestKind)) {
      return { ok: false, message: `${kind} non è una richiesta che il daemon accetta` };
    }
    if (!role.requests.includes(kind as RequestKind)) {
      return { ok: false, message: `il ruolo ${role.name} non può chiedere ${kind}` };
    }

    let resolved = payload;
    if (kind === "open_task") {
      const rung = this.#resolveRung(payload);
      if ("error" in rung) return { ok: false, message: rung.error };
      resolved = { ...payload, model: rung.model, effort: rung.effort };
    }

    const gate = kind === "merge_production" ? "always" : this.#gateFor(kind, resolved);
    const now = clock.now();
    const id = db.orm.transaction((tx) => {
      const inserted = tx
        .insert(schema.requests)
        .values({
          agent,
          kind,
          payload: resolved,
          status: gate === "none" ? "approved" : "pending",
          createdAt: now,
          ...(gate === "none" ? { decidedBy: "daemon", decidedAt: now } : {}),
        })
        .returning({ id: schema.requests.id })
        .get().id;
      appendEvent(tx, {
        at: now,
        kind: "request.created",
        agent,
        payload: { requestId: inserted, kind, gate },
      });
      return inserted;
    });

    if (gate === "none") {
      this.#deps.onApproved?.(id, kind, agent, resolved);
      return { ok: true, id, status: "approved", message: `richiesta #${id} approvata` };
    }

    const reason = typeof resolved.reason === "string" ? resolved.reason : "nessuno";
    const title = typeof resolved.title === "string" ? resolved.title : kind;
    const line =
      kind === "merge_production"
        ? `${agent} chiede di unire su *${String(resolved.branch ?? "produzione")}*`
        : `${agent} chiede *${String(resolved.model)}* per *${title}*`;
    renderApprovalCard(db, clock, {
      kind,
      agent,
      channel: this.#deps.channelFor(agent),
      line,
      context: `${line.split(" ")[0]} · motivo: ${reason}`,
      destructive: kind === "merge_production",
      scoped: false,
      epoch: 0,
      subject: { kind: "request", id },
      details: resolved,
    });
    return {
      ok: true,
      id,
      status: "pending",
      message: `richiesta #${id}: in attesa del proprietario`,
    };
  }

  /** The preset or the explicit pair, checked against the job role's menu. */
  #resolveRung(
    payload: Record<string, unknown>,
  ): { model: string; effort: string } | { error: string } {
    const snapshot = this.#deps.holder.current;
    const roleName = ROLE_FOR_TASK_KIND[String(payload.kind ?? "develop")];
    if (!roleName) return { error: `non conosco il tipo di compito ${String(payload.kind)}` };
    const role = snapshot.roles.get(roleName);
    if (!role) return { error: `il ruolo ${roleName} non esiste in questa configurazione` };

    const preset = typeof payload.preset === "string" ? PRESETS[payload.preset] : undefined;
    const model = String(payload.model ?? preset?.model ?? role.model);
    const effort = String(payload.effort ?? preset?.effort ?? role.effort ?? "high");
    if (typeof payload.preset === "string" && !preset) {
      return { error: `il preset ${payload.preset} non esiste` };
    }

    const menu = role.menu;
    if (menu) {
      // a gated value is not in the menu but is still askable: the owner decides (A3)
      const gated = snapshot.config.gated.models;
      if (!menu.models.includes(model) && !gated.includes(model)) {
        return { error: `${model} non è nel menù di ${roleName}` };
      }
      if (!(menu.efforts as readonly string[]).includes(effort)) {
        return { error: `${effort} non è nel menù di ${roleName}` };
      }
    }
    return { model, effort };
  }

  #gateFor(_kind: string, payload: Record<string, unknown>): "none" | "gated" {
    const gated = this.#deps.holder.current.config.gated.models;
    return typeof payload.model === "string" && gated.includes(payload.model) ? "gated" : "none";
  }

  /** The owner pressed Approva or Nega on a request's card. */
  decide(requestId: number, decision: "approved" | "denied", by: string): boolean {
    const { db, clock } = this.#deps;
    const row = db.orm
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.id, requestId))
      .get();
    if (row?.status !== "pending") return false;
    const now = clock.now();
    db.orm.transaction((tx) => {
      tx.update(schema.requests)
        .set({ status: decision, decidedBy: by, decidedAt: now })
        .where(eq(schema.requests.id, requestId))
        .run();
      appendEvent(tx, {
        at: now,
        kind: `request.${decision}`,
        agent: row.agent,
        payload: { requestId, by },
      });
    });
    if (decision === "approved") {
      this.#deps.onApproved?.(requestId, row.kind, row.agent, row.payload);
    }
    this.#deps.wakeAgent(row.agent, `request ${decision}`);
    return true;
  }

  /** 24 h by config; merge_production never expires (spec section 10). */
  expire(): number[] {
    const { db, clock, holder } = this.#deps;
    const cutoff = clock.now() - holder.current.config.approvals.timeout_hours * 3_600_000;
    const expired: number[] = [];
    for (const row of db.orm
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.status, "pending"))
      .all()) {
      if (row.kind === "merge_production") continue;
      if (row.createdAt > cutoff) continue;
      db.orm
        .update(schema.requests)
        .set({ status: "expired", decidedAt: clock.now() })
        .where(eq(schema.requests.id, row.id))
        .run();
      db.orm.transaction((tx) => {
        appendEvent(tx, {
          at: clock.now(),
          kind: "request.expired",
          agent: row.agent,
          payload: { requestId: row.id },
        });
      });
      this.#deps.wakeAgent(row.agent, "request expired");
      expired.push(row.id);
    }
    return expired;
  }

  /** Riapri on an expired card: a new epoch, so the old buttons are stale. */
  reopen(renderId: number): boolean {
    const { db, clock } = this.#deps;
    const payload = renderPayload(db, renderId);
    if (payload?.subject.kind !== "request") return false;
    const row = db.orm
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.id, payload.subject.id))
      .get();
    if (row?.status !== "expired") return false;
    const now = clock.now();
    db.orm
      .update(schema.requests)
      .set({ status: "pending", decidedAt: null, epoch: row.epoch + 1 })
      .where(eq(schema.requests.id, row.id))
      .run();
    renderApprovalCard(db, clock, {
      kind: row.kind,
      agent: row.agent,
      channel: payload.channel,
      line: payload.card.text,
      context: `riaperta · ${row.agent}`,
      destructive: row.kind === "merge_production",
      scoped: false,
      epoch: row.epoch + 1,
      subject: { kind: "request", id: row.id },
      details: row.payload,
    });
    appendEvent2(db, now, row.agent, { renderId, requestId: row.id, epoch: row.epoch + 1 });
    return true;
  }

  /** A click carrying an epoch the row has moved past decides nothing (spec section 9). */
  epochIsCurrent(renderId: number, epoch: number): boolean {
    const payload = renderPayload(this.#deps.db, renderId);
    return payload !== undefined && payload.epoch === epoch;
  }

  rewrite(renderId: number, outcome: "approvato" | "negato" | "scaduta", by: string | undefined) {
    rewriteCard(this.#deps.db, this.#deps.clock, renderId, outcome, by);
  }
}

function appendEvent2(db: Db, at: number, agent: string, payload: unknown): void {
  db.orm.transaction((tx) => {
    appendEvent(tx, { at, kind: "request.reopened", agent, payload });
  });
}
