// Every agent's loop, the global cap, and what a turn actually is (spec sections 3, 6, 13).
// The scheduler owns no queue: the pending set is a query, so a restart replays wakes for free.
import { Cron } from "croner";
import { eq, inArray } from "drizzle-orm";
import pLimit from "p-limit";
import type { SnapshotHolder } from "../config/holder.js";
import type { Clock } from "../ports/clock.js";
import type { Ids } from "../ports/ids.js";
import type {
  AgentRunner,
  PermissionDecision,
  PermissionRequest,
  RateLimitInfo,
  TurnOutcome,
} from "../ports/runner.js";
import type { Db } from "../store/db.js";
import { appendEvent } from "../store/events.js";
import { appendMessage, recordDelivery } from "../store/messages.js";
import * as schema from "../store/schema.js";
import { deliverEnvelope, parseEnvelope } from "../turn/envelope.js";
import { buildTurnPrompt } from "../turn/prompt.js";
import { buildTurnSpec, ensureSession, resolveRung } from "../turn/spec.js";
import { collectTurnInput, hasWork, markOutcomesTold } from "../turn/state.js";
import { AgentLoop } from "./agent-loop.js";

export type SchedulerDeps = {
  db: Db;
  clock: Clock;
  ids: Ids;
  holder: SnapshotHolder;
  runner: AgentRunner;
  runsDir: string;
  hookPath: string;
  /** false when the agent is paused, the plan is limit-paused, or its rung is refused */
  mayRun(agent: string): boolean;
  /** the permission broker; only the scheduler knows which agent and turn asked */
  onPermission(agent: string, turnId: number, req: PermissionRequest): Promise<PermissionDecision>;
  onRateLimit?(info: RateLimitInfo): void;
  onTurnFinished?(agent: string, turnId: number, outcome: TurnOutcome): void;
  log?(line: string, fields?: Record<string, unknown>): void;
};

const DRAIN_MS = 120_000;

export class Scheduler {
  readonly #deps: SchedulerDeps;
  readonly #loops = new Map<string, AgentLoop>();
  readonly #crons: Cron[] = [];
  #limit = pLimit(3);
  #stopped = false;

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
    this.#limit.concurrency = deps.holder.current.config.max_concurrent_turns;
  }

  /** A8: drop to one turn at a time before the plan's limit, and back afterwards. */
  setConcurrency(n: number): void {
    this.#limit.concurrency = Math.max(1, n);
  }

  get concurrency(): number {
    return this.#limit.concurrency;
  }

  get runningTurns(): number {
    return this.#limit.activeCount;
  }

  get queueDepth(): number {
    return this.#limit.pendingCount;
  }

  loopFor(agent: string): AgentLoop {
    let loop = this.#loops.get(agent);
    if (!loop) {
      loop = new AgentLoop(agent, {
        limit: (fn) => this.#limit(fn),
        mayRun: (a) => !this.#stopped && this.#deps.mayRun(a),
        hasWork: (a) => hasWork(this.#deps.db, a),
        runTurn: (a) => this.runTurn(a),
        onError: (a, e) =>
          this.#deps.log?.("turn failed outside the runner", { agent: a, error: String(e) }),
      });
      this.#loops.set(agent, loop);
    }
    return loop;
  }

  wakeAgent(agent: string, reason: string): void {
    if (agent === "owner") return; // the owner is not an agent and has no turns
    this.loopFor(agent).wake(reason);
  }

  /** Every agent the store or the snapshot knows, standing or job, not retired. */
  knownAgents(): string[] {
    const names = new Set<string>(this.#deps.holder.current.agents.keys());
    for (const row of this.#deps.db.orm.select().from(schema.agents).all()) {
      if (row.retiredAt === null) names.add(row.name);
    }
    return [...names].sort();
  }

  /** Boot replay: anything with pending work is woken. Nothing durable is needed. */
  replayWakes(): string[] {
    const woken: string[] = [];
    for (const agent of this.knownAgents()) {
      if (hasWork(this.#deps.db, agent)) {
        this.wakeAgent(agent, "boot replay");
        woken.push(agent);
      }
    }
    return woken;
  }

  /**
   * A turn that was running when the daemon died is interrupted, never re-run (spec section 13):
   * the agent is told its turn was cut and the channel is the truth.
   */
  markInterruptedTurns(): number[] {
    const { db, clock } = this.#deps;
    const running = db.orm
      .select()
      .from(schema.turns)
      .where(eq(schema.turns.status, "running"))
      .all();
    if (running.length === 0) return [];
    const now = clock.now();
    db.orm.transaction((tx) => {
      tx.update(schema.turns)
        .set({ status: "interrupted", endedAt: now, error: "daemon restarted mid-turn" })
        .where(
          inArray(
            schema.turns.id,
            running.map((t) => t.id),
          ),
        )
        .run();
      for (const t of running) {
        appendEvent(tx, {
          at: now,
          kind: "turn.interrupted",
          agent: t.agent,
          payload: { turnId: t.id },
        });
      }
    });
    for (const t of running)
      this.#systemNote(
        t.agent,
        "Il tuo turno è stato interrotto da un riavvio del daemon. Quello che leggi nel canale è la verità.",
      );
    return running.map((t) => t.id);
  }

  /**
   * The CLI children a dead daemon left behind (spec section 13). Their pid is on the turn row,
   * which is the only portable way to find them: AGENTOPOLIS_TURN_ID is in their environment, and
   * an environment is not something `pgrep -f` can see. Each was spawned in its own process
   * group, so killing the group takes the grandchildren with it.
   */
  reapOrphans(): number[] {
    const reaped: number[] = [];
    for (const turn of this.#deps.db.orm
      .select()
      .from(schema.turns)
      .where(eq(schema.turns.status, "running"))
      .all()) {
      if (turn.pid === null || turn.pid <= 1) continue;
      for (const target of [-turn.pid, turn.pid]) {
        try {
          process.kill(target, "SIGKILL");
          reaped.push(turn.pid);
          break;
        } catch {
          // already gone, or never a group leader
        }
      }
    }
    return reaped;
  }

  /** Declared schedules (spec section 5): a fire posts a system message, which wakes the agent. */
  startSchedules(): void {
    for (const s of this.#deps.db.orm.select().from(schema.schedules).all()) {
      const cron = new Cron(s.cron, () => {
        this.#systemNote(s.agent, s.prompt);
        this.#deps.db.orm
          .update(schema.schedules)
          .set({ lastFired: this.#deps.clock.now() })
          .where(eq(schema.schedules.id, s.id))
          .run();
      });
      this.#crons.push(cron);
    }
  }

  /** One turn: consume what is pending, spawn, record, deliver the envelope. */
  async runTurn(agent: string): Promise<void> {
    const { db, clock, ids, holder, runner, runsDir, hookPath } = this.#deps;
    const snapshot = holder.current;
    const row = db.orm.select().from(schema.agents).where(eq(schema.agents.name, agent)).get();
    const file = snapshot.agents.get(agent);
    const role = snapshot.roles.get(file?.role ?? row?.role ?? "");
    if (!role) {
      this.#deps.log?.("no role for agent", { agent });
      return;
    }
    const task =
      row?.taskId != null
        ? db.orm.select().from(schema.tasks).where(eq(schema.tasks.id, row.taskId)).get()
        : undefined;
    const rung = resolveRung(
      role,
      file?.model ?? null,
      file?.effort ?? null,
      task ? { model: task.model, effort: task.effort } : undefined,
    );

    const input = collectTurnInput(db, snapshot, agent, rung);
    if (input.messageIds.length === 0 && input.outcomes.length === 0) return;

    // the session id must exist before the turn row names it
    const { sessionId } = ensureSession(snapshot, db, clock, ids, agent);
    const startedAt = clock.now();
    const turnId = db.orm.transaction((tx) => {
      const id = tx
        .insert(schema.turns)
        .values({
          agent,
          startedAt,
          status: "running",
          sessionId,
          configVersion: snapshot.version,
        })
        .returning({ id: schema.turns.id })
        .get().id;
      appendEvent(tx, { at: startedAt, kind: "turn.started", agent, payload: { turnId: id } });
      return id;
    });
    // the delivery guarantee: these messages are this turn's, crash or no crash
    recordDelivery(db, turnId, input.messageIds);
    markOutcomesTold(db, startedAt, input.requestIds, input.permissionIds);

    const spec = buildTurnSpec(snapshot, db, clock, ids, agent, {
      turnId,
      prompt: buildTurnPrompt(input),
      runsDir,
      hookPath,
    });

    let outcome: TurnOutcome;
    try {
      outcome = await runner.run(spec, {
        onPermission: (req) => this.#deps.onPermission(agent, turnId, req),
        onSpawn: (pid) => {
          if (pid !== undefined) {
            db.orm.update(schema.turns).set({ pid }).where(eq(schema.turns.id, turnId)).run();
          }
        },
        ...(this.#deps.onRateLimit ? { onRateLimit: this.#deps.onRateLimit } : {}),
      });
    } catch (error) {
      this.#finish(turnId, agent, {
        status: "failed",
        error: String(error),
      });
      throw error;
    }

    this.#finish(turnId, agent, {
      status: outcome.status,
      sessionId: outcome.sessionId,
      costMicro: outcome.costMicro,
      costBasis: outcome.costBasis,
      modelUsage: outcome.modelUsage,
      cacheRead: outcome.cacheRead,
      cacheCreation: outcome.cacheCreation,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });

    if (outcome.status === "ok") this.#deliver(agent, turnId, outcome);
    this.#deps.onTurnFinished?.(agent, turnId, outcome);
  }

  #deliver(agent: string, turnId: number, outcome: TurnOutcome): void {
    const { db, clock, holder } = this.#deps;
    // the envelope arrives as the result's structured_output, validated by --json-schema
    // [live check 3, 2026-09-18]; no structured output at all is a failed turn (spec section 13)
    const parsed =
      outcome.structuredOutput === undefined
        ? { ok: false as const, error: "the result carried no structured_output" }
        : parseEnvelope(outcome.structuredOutput);
    if (!parsed.ok) {
      db.orm.transaction((tx) => {
        appendEvent(tx, {
          at: clock.now(),
          kind: "envelope.missing",
          agent,
          payload: { turnId, error: parsed.error },
        });
      });
      db.orm
        .update(schema.turns)
        .set({ status: "failed", error: `envelope: ${parsed.error}` })
        .where(eq(schema.turns.id, turnId))
        .run();
      return;
    }
    const delivered = deliverEnvelope(db, clock, holder.current, agent, parsed.envelope);
    for (const who of delivered.wakes) this.wakeAgent(who, `message from ${agent}`);
  }

  #finish(
    turnId: number,
    agent: string,
    o: {
      status: string;
      sessionId?: string;
      costMicro?: number | null;
      costBasis?: string | null;
      modelUsage?: unknown;
      cacheRead?: number | null;
      cacheCreation?: number | null;
      error?: string;
    },
  ): void {
    const { db, clock } = this.#deps;
    const now = clock.now();
    db.orm.transaction((tx) => {
      tx.update(schema.turns)
        .set({
          status: o.status as typeof schema.turns.$inferSelect.status,
          endedAt: now,
          costMicrousd: o.costMicro ?? null,
          costBasis: o.costBasis ?? null,
          modelUsage: o.modelUsage ?? null,
          cacheRead: o.cacheRead ?? null,
          cacheCreation: o.cacheCreation ?? null,
          error: o.error ?? null,
        })
        .where(eq(schema.turns.id, turnId))
        .run();
      appendEvent(tx, {
        at: now,
        kind: "turn.finished",
        agent,
        payload: { turnId, status: o.status, costMicrousd: o.costMicro ?? null },
      });
    });
  }

  #systemNote(agent: string, body: string): void {
    const { db, clock } = this.#deps;
    const container = db.orm
      .select()
      .from(schema.containers)
      .all()
      .find((c) => c.members.includes(agent));
    if (!container) return;
    appendMessage(db, clock, {
      containerId: container.id,
      author: "daemon",
      to: agent,
      body,
      kind: "system",
    });
    this.wakeAgent(agent, "system note");
  }

  /** Stop wakes, then let the turns in flight finish, bounded (spec section 13). */
  async stop(drainMs = DRAIN_MS): Promise<void> {
    this.#stopped = true;
    for (const cron of this.#crons) cron.stop();
    this.#crons.length = 0;
    for (const loop of this.#loops.values()) loop.stop();
    const deadline = Date.now() + drainMs;
    while (this.#limit.activeCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await Promise.all([...this.#loops.values()].map((l) => l.settled()));
  }
}
