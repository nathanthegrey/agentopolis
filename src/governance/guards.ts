// What bounds an exchange the per-turn guards cannot see (A5, D3). Every counter here is a query
// over rows, never an in-memory flag a crash could leave set, and every trip writes its event.
import { and, desc, eq, gt } from "drizzle-orm";
import type { SnapshotHolder } from "../config/holder.js";
import type { Clock } from "../ports/clock.js";
import type { RateLimitInfo } from "../ports/runner.js";
import type { Card } from "../slack/blocks.js";
import type { Db } from "../store/db.js";
import { appendEvent } from "../store/events.js";
import * as schema from "../store/schema.js";
import { postCard, updateCard } from "./cards.js";

/** Neither the owner nor the daemon counts towards an agent-to-agent loop. */
const NOT_AN_AGENT = new Set(["owner", "daemon"]);

export type GuardsDeps = {
  db: Db;
  clock: Clock;
  holder: SnapshotHolder;
  /** a system note into the task's thread, addressed to one member */
  systemNote(agent: string, containerId: number, body: string): void;
  log?(line: string, fields?: Record<string, unknown>): void;
};

export type ResetPoint = { messageId: number; at: number };

/** The container a task's traffic lives in. */
export function taskContainer(db: Db, taskId: number) {
  return db.orm.select().from(schema.containers).where(eq(schema.containers.taskId, taskId)).get();
}

/**
 * Counters reset on any owner message in the thread, and whenever the owner unblocks it.
 * Messages are counted by id and events by time, because only messages have a shared sequence.
 */
export function resetPoint(db: Db, taskId: number): ResetPoint {
  const container = taskContainer(db, taskId);
  let point: ResetPoint = { messageId: 0, at: 0 };
  if (container) {
    const lastOwner = db.orm
      .select()
      .from(schema.messages)
      .where(
        and(eq(schema.messages.containerId, container.id), eq(schema.messages.author, "owner")),
      )
      .orderBy(desc(schema.messages.id))
      .get();
    if (lastOwner) point = { messageId: lastOwner.id, at: lastOwner.createdAt };
  }
  const reset = db.orm
    .select()
    .from(schema.events)
    .where(eq(schema.events.kind, "task.counters_reset"))
    .all()
    .filter((e) => (e.payload as { taskId?: number }).taskId === taskId)
    .at(-1);
  if (reset) {
    const sinceMessageId = (reset.payload as { sinceMessageId?: number }).sinceMessageId ?? 0;
    if (reset.at >= point.at)
      point = { messageId: Math.max(point.messageId, sinceMessageId), at: reset.at };
  }
  return point;
}

export function agentMessagesSince(db: Db, taskId: number, point: ResetPoint): number {
  const container = taskContainer(db, taskId);
  if (!container) return 0;
  return db.orm
    .select()
    .from(schema.messages)
    .where(
      and(eq(schema.messages.containerId, container.id), gt(schema.messages.id, point.messageId)),
    )
    .all()
    .filter((m) => !NOT_AN_AGENT.has(m.author)).length;
}

/**
 * A rejected review is a `review_rejected` event; slice 6 writes one when a reviewer sends a
 * report back. In this slice the event is the contract.
 */
export function reviewRejectionsSince(db: Db, taskId: number, at: number): number {
  return db.orm
    .select()
    .from(schema.events)
    .where(eq(schema.events.kind, "review_rejected"))
    .all()
    .filter((e) => (e.payload as { taskId?: number }).taskId === taskId && e.at > at).length;
}

export type LoopGuardVerdict =
  | { tripped: false }
  | { tripped: true; why: "messages" | "review_rejections"; count: number };

export class Guards {
  readonly #deps: GuardsDeps;

  constructor(deps: GuardsDeps) {
    this.#deps = deps;
  }

  /** A5: nothing else bounds an agent ⇄ agent exchange, so the daemon counts per task. */
  loopGuard(taskId: number): LoopGuardVerdict {
    const { db, holder } = this.#deps;
    const limits = holder.current.config.loop_guard;
    const point = resetPoint(db, taskId);
    const messages = agentMessagesSince(db, taskId, point);
    if (messages >= limits.messages) return { tripped: true, why: "messages", count: messages };
    const rejections = reviewRejectionsSince(db, taskId, point.at);
    if (rejections >= limits.review_rejections) {
      return { tripped: true, why: "review_rejections", count: rejections };
    }
    return { tripped: false };
  }

  /** Blocks the task: its agents get a note and no further wake until the owner presses. */
  blockTask(taskId: number, verdict: Extract<LoopGuardVerdict, { tripped: true }>): boolean {
    const { db, clock } = this.#deps;
    const task = db.orm.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    if (!task || task.status === "blocked") return false;
    const now = clock.now();
    db.orm.transaction((tx) => {
      tx.update(schema.tasks).set({ status: "blocked" }).where(eq(schema.tasks.id, taskId)).run();
      appendEvent(tx, {
        at: now,
        kind: "task.blocked",
        payload: { taskId, why: verdict.why, count: verdict.count },
      });
    });
    const container = taskContainer(db, taskId);
    if (container) {
      const why =
        verdict.why === "messages"
          ? `Il compito è bloccato: ${verdict.count} messaggi fra agenti senza che il proprietario intervenisse.`
          : `Il compito è bloccato: ${verdict.count} revisioni rifiutate.`;
      for (const member of container.members) {
        if (NOT_AN_AGENT.has(member)) continue;
        this.#deps.systemNote(member, container.id, `${why} Aspetta il proprietario.`);
      }
    }
    return true;
  }

  /** No agent of a blocked task gets another turn until the owner presses Sblocca. */
  taskIsBlocked(agent: string): boolean {
    const { db } = this.#deps;
    const row = db.orm.select().from(schema.agents).where(eq(schema.agents.name, agent)).get();
    if (row?.taskId == null) return false;
    const task = db.orm.select().from(schema.tasks).where(eq(schema.tasks.id, row.taskId)).get();
    return task?.status === "blocked";
  }

  /** Sblocca: the task runs again and every counter starts from here. */
  unblockTask(taskId: number): boolean {
    const { db, clock } = this.#deps;
    const task = db.orm.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    if (task?.status !== "blocked") return false;
    const container = taskContainer(db, taskId);
    const sinceMessageId = container
      ? (db.orm
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.containerId, container.id))
          .orderBy(desc(schema.messages.id))
          .get()?.id ?? 0)
      : 0;
    const now = clock.now();
    db.orm.transaction((tx) => {
      tx.update(schema.tasks).set({ status: "open" }).where(eq(schema.tasks.id, taskId)).run();
      appendEvent(tx, {
        at: now,
        kind: "task.counters_reset",
        payload: { taskId, sinceMessageId },
      });
      appendEvent(tx, { at: now, kind: "task.unblocked", payload: { taskId } });
    });
    return true;
  }

  // ---- the rung counter (D3) ----------------------------------------------------------------

  /** When this task's current rung started: the last rung change, else the task's own start. */
  #rungSince(taskId: number, openedAt: number): number {
    return (
      this.#deps.db.orm
        .select()
        .from(schema.events)
        .where(eq(schema.events.kind, "task.rung_changed"))
        .all()
        .filter((e) => (e.payload as { taskId?: number }).taskId === taskId)
        .at(-1)?.at ?? openedAt
    );
  }

  /**
   * D3: the daemon cannot see a failed test, except at one point — the report envelope. Two
   * reports with tests_green false on the same rung, or two rejected reviews, and no further
   * turn on that rung. The lead reopens one rung up or asks the owner.
   */
  rungRefused(agent: string): boolean {
    const { db } = this.#deps;
    const row = db.orm.select().from(schema.agents).where(eq(schema.agents.name, agent)).get();
    if (row?.taskId == null) return false;
    const task = db.orm.select().from(schema.tasks).where(eq(schema.tasks.id, row.taskId)).get();
    if (!task) return false;
    const since = this.#rungSince(task.id, task.openedAt);

    const redReports = db.orm
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.author, agent),
          eq(schema.messages.kind, "report"),
          eq(schema.messages.testsGreen, false),
        ),
      )
      .all()
      .filter((m) => m.createdAt >= since).length;
    if (redReports >= 2) return this.#refuse(task, agent, redReports, "test rossi");

    const rejections = reviewRejectionsSince(db, task.id, since);
    if (rejections >= 2) return this.#refuse(task, agent, rejections, "revisioni rifiutate");
    return false;
  }

  #refuse(task: typeof schema.tasks.$inferSelect, agent: string, count: number, why: string): true {
    const { db, clock } = this.#deps;
    const rung = `${task.model ?? "?"}/${task.effort ?? "?"}`;
    const already = db.orm
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, "rung.refused"))
      .all()
      .some((e) => {
        const p = e.payload as { taskId?: number; rung?: string };
        return p.taskId === task.id && p.rung === rung;
      });
    if (already) return true;
    const now = clock.now();
    db.orm.transaction((tx) => {
      appendEvent(tx, {
        at: now,
        kind: "rung.refused",
        agent,
        payload: { taskId: task.id, rung, count, why },
      });
    });
    const container = taskContainer(db, task.id);
    if (container) {
      this.#deps.systemNote(
        task.lead,
        container.id,
        `${agent} è fermo sul gradino ${rung} (${count} ${why}): riapri un gradino sopra o chiedi al proprietario.`,
      );
    }
    return true;
  }

  /** A rung change is a new session for the job agent (A2); the counter starts again. */
  changeRung(taskId: number, model: string, effort: string): void {
    const { db, clock } = this.#deps;
    const now = clock.now();
    db.orm.transaction((tx) => {
      tx.update(schema.tasks).set({ model, effort }).where(eq(schema.tasks.id, taskId)).run();
      appendEvent(tx, {
        at: now,
        kind: "task.rung_changed",
        payload: { taskId, model, effort },
      });
    });
  }
}

// ---- the plan's own limit (A8 and spec section 13) --------------------------------------------
// There is no paid overflow, ever (owner, 2026-09-19: "free or nothing"): the company stops at
// the limit and starts again at resetsAt. State lives in events, so a restart derives it.

const FIFTEEN_MINUTES = 15 * 60_000;
/** the utilization at which the daemon stops filling every slot */
export const BACKOFF_AT = 0.9;

export type PlanLimitsDeps = {
  db: Db;
  clock: Clock;
  holder: SnapshotHolder;
  /** the ceo's direct message: where the one limit notice lives */
  ownerChannel(): string;
  onConcurrencyChange(n: number): void;
  log?(line: string, fields?: Record<string, unknown>): void;
};

const hhmm = (at: number): string =>
  new Date(at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

const limitCard = (until: number): Card => ({
  text: `Limite del piano raggiunto: riparto alle ${hhmm(until)}.`,
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⏸️ Limite del piano raggiunto: riparto alle *${hhmm(until)}*.`,
      },
    },
  ],
});

type PauseState = { until: number; outboxId: number | null } | undefined;

export class PlanLimits {
  readonly #deps: PlanLimitsDeps;

  constructor(deps: PlanLimitsDeps) {
    this.#deps = deps;
  }

  /** Derived from events, so a restart restores it (spec section 13). */
  #pause(): PauseState {
    const rows = this.#deps.db.orm
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, "limit.pause"))
      .all();
    const last = rows.at(-1);
    if (!last) return undefined;
    const resumed = this.#deps.db.orm
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, "limit.resume"))
      .all()
      .some((e) => e.at >= last.at);
    if (resumed) return undefined;
    const payload = last.payload as { until: number; outboxId: number | null };
    return { until: payload.until, outboxId: payload.outboxId ?? null };
  }

  get pausedUntil(): number | null {
    const pause = this.#pause();
    if (!pause) return null;
    if (this.#deps.clock.now() >= pause.until) {
      this.resume();
      return null;
    }
    return pause.until;
  }

  /** No turn starts while the plan's window is exhausted. */
  mayRun(): boolean {
    return this.pausedUntil === null;
  }

  onRateLimit(info: RateLimitInfo): void {
    const worst = Math.max(0, ...Object.values(info.windows).map((w) => w.utilization));
    const exhausted = info.status !== "allowed" && info.status !== "allowed_warning";
    if (exhausted) {
      this.pause(info.resetsAt ?? this.#deps.clock.now() + FIFTEEN_MINUTES);
      return;
    }
    if (info.status === "allowed_warning" || worst >= BACKOFF_AT) {
      this.#backoff(info.resetsAt ?? null);
      return;
    }
    this.#clearBackoff();
  }

  /** Two api_retry events running with rate_limit or overloaded is the same pause. */
  onApiRetry(kind: string): void {
    const { db, clock } = this.#deps;
    if (kind !== "rate_limit" && kind !== "overloaded") return;
    db.orm.transaction((tx) => {
      appendEvent(tx, { at: clock.now(), kind: "limit.api_retry", payload: { kind } });
    });
    const recent = db.orm
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, "limit.api_retry"))
      .all();
    const lastResume = db.orm
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, "limit.resume"))
      .all()
      .at(-1);
    const running = recent.filter((e) => e.at >= (lastResume?.at ?? 0)).length;
    if (running >= 2) this.pause(clock.now() + FIFTEEN_MINUTES);
  }

  pause(until: number): void {
    const { db, clock } = this.#deps;
    const current = this.#pause();
    if (current) {
      // the notice repeats: edit it rather than posting a new one
      if (current.until !== until && current.outboxId !== null) {
        updateCard(db, clock, current.outboxId, limitCard(until));
      }
      db.orm.transaction((tx) => {
        appendEvent(tx, {
          at: clock.now(),
          kind: "limit.pause",
          payload: { until, outboxId: current.outboxId },
        });
      });
      return;
    }
    const outboxId = postCard(db, clock, this.#deps.ownerChannel(), limitCard(until));
    db.orm.transaction((tx) => {
      appendEvent(tx, { at: clock.now(), kind: "limit.pause", payload: { until, outboxId } });
    });
    this.#deps.log?.("plan limit reached", { until });
  }

  resume(): void {
    const { db, clock } = this.#deps;
    db.orm.transaction((tx) => {
      appendEvent(tx, { at: clock.now(), kind: "limit.resume", payload: {} });
    });
    this.#deps.onConcurrencyChange(this.#deps.holder.current.config.max_concurrent_turns);
  }

  #backoff(until: number | null): void {
    const { db, clock } = this.#deps;
    const last = db.orm
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, "limit.backoff"))
      .all()
      .at(-1);
    const lastClear = db.orm
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, "limit.backoff_cleared"))
      .all()
      .at(-1);
    const alreadyOn = last !== undefined && (lastClear === undefined || lastClear.at < last.at);
    if (alreadyOn) return;
    db.orm.transaction((tx) => {
      appendEvent(tx, { at: clock.now(), kind: "limit.backoff", payload: { until } });
    });
    this.#deps.onConcurrencyChange(1);
  }

  #clearBackoff(): void {
    const { db, clock } = this.#deps;
    const last = db.orm
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, "limit.backoff"))
      .all()
      .at(-1);
    if (!last) return;
    const lastClear = db.orm
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, "limit.backoff_cleared"))
      .all()
      .at(-1);
    if (lastClear !== undefined && lastClear.at >= last.at) return;
    db.orm.transaction((tx) => {
      appendEvent(tx, { at: clock.now(), kind: "limit.backoff_cleared", payload: {} });
    });
    this.#deps.onConcurrencyChange(this.#deps.holder.current.config.max_concurrent_turns);
  }

  get backedOff(): boolean {
    const { db } = this.#deps;
    const last = db.orm
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, "limit.backoff"))
      .all()
      .at(-1);
    if (!last) return false;
    const lastClear = db.orm
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, "limit.backoff_cleared"))
      .all()
      .at(-1);
    return lastClear === undefined || lastClear.at < last.at;
  }

  /** What the Home tab shows: hours the company stood still this month. */
  pausedMsThisMonth(now: number): number {
    const start = new Date(now);
    const monthStart = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
    const events = this.#deps.db.orm
      .select()
      .from(schema.events)
      .all()
      .filter((e) => e.at >= monthStart && (e.kind === "limit.pause" || e.kind === "limit.resume"));
    let total = 0;
    let openedAt: number | undefined;
    for (const e of events) {
      if (e.kind === "limit.pause") {
        openedAt ??= e.at;
      } else if (openedAt !== undefined) {
        total += e.at - openedAt;
        openedAt = undefined;
      }
    }
    if (openedAt !== undefined) total += now - openedAt;
    return total;
  }
}
