// Tier 2 of spec section 10, as the owner decided on 2026-09-19 (D1): what no role rule covers
// is HELD, with the card already on the owner's phone, and only then PARKED.
// A held turn continues exactly where it was and pays nothing; a parked one pays a whole
// re-planning turn, which is why the hold comes first.
import { and, eq } from "drizzle-orm";
import type { SnapshotHolder } from "../config/holder.js";
import { decide } from "../engine/permissions.js";
import type { Clock } from "../ports/clock.js";
import type { PermissionDecision, PermissionRequest } from "../ports/runner.js";
import type { Timers } from "../ports/timers.js";
import type { Db } from "../store/db.js";
import { appendEvent } from "../store/events.js";
import * as schema from "../store/schema.js";
import { renderApprovalCard } from "./cards.js";

/**
 * Written for the model, not for a log: a deny that does not say this is treated as an obstacle
 * and the agent tries variants instead of ending its turn (A7).
 */
export const PARKED_DENY =
  "Parcheggiato per il proprietario: chiudi ora il turno con la tua busta; sarai risvegliato con la decisione.";

export type PermissionBrokerDeps = {
  db: Db;
  clock: Clock;
  timers: Timers;
  holder: SnapshotHolder;
  /** where the owner sees this agent's cards: its DM, its -hq channel, or its task thread */
  channelFor(agent: string): string;
  wakeAgent(agent: string, reason: string): void;
  log?(line: string, fields?: Record<string, unknown>): void;
};

type Held = { resolve(d: PermissionDecision): void; cancel(): void; agent: string };

export class PermissionBroker {
  readonly #deps: PermissionBrokerDeps;
  /** permission_requests.id → the turn waiting on it */
  readonly #held = new Map<number, Held>();

  constructor(deps: PermissionBrokerDeps) {
    this.#deps = deps;
  }

  get heldCount(): number {
    return this.#held.size;
  }

  async onPermission(
    agent: string,
    turnId: number,
    req: PermissionRequest,
  ): Promise<PermissionDecision> {
    const { db, clock, timers, holder } = this.#deps;
    const snapshot = holder.current;
    const row = db.orm.select().from(schema.agents).where(eq(schema.agents.name, agent)).get();
    const role = snapshot.roles.get(snapshot.agents.get(agent)?.role ?? row?.role ?? "");
    if (!role) return { behavior: "deny", message: `no role for ${agent}` };

    const ruled = decide(role, req);
    if (ruled === "allow") return { behavior: "allow" };
    if (ruled === "deny") {
      return {
        behavior: "deny",
        message: `La regola del tuo ruolo vieta ${req.toolName}. Non riprovare con una variante.`,
      };
    }

    // "Approva per questo compito" already let this tool through for this task
    if (row?.taskId != null && this.#allowedForTask(row.taskId, req.toolName)) {
      return { behavior: "allow" };
    }

    const now = clock.now();
    const permissionId = db.orm
      .insert(schema.permissionRequests)
      .values({
        turnId,
        toolUseId: req.toolUseId,
        toolName: req.toolName,
        input: req.input,
        scope: "once",
        status: "pending",
        createdAt: now,
        taskId: row?.taskId ?? null,
      })
      .returning({ id: schema.permissionRequests.id })
      .get().id;

    renderApprovalCard(db, clock, {
      kind: "permission",
      agent,
      channel: this.#deps.channelFor(agent),
      line: `${agent} chiede di usare *${req.toolName}*`,
      context: `permesso · ${agent}`,
      destructive: false,
      scoped: true,
      epoch: 0,
      subject: { kind: "permission", id: permissionId },
      details: { tool: req.toolName, input: req.input },
    });

    const holdMs = snapshot.config.permission_hold_minutes * 60_000;
    return await new Promise<PermissionDecision>((resolve) => {
      const cancel = timers.after(holdMs, () => {
        // the hold ran out: park it. The row stays pending and the card stays live.
        this.#held.delete(permissionId);
        this.#deps.db.orm.transaction((tx) => {
          appendEvent(tx, {
            at: this.#deps.clock.now(),
            kind: "permission.parked",
            agent,
            payload: { permissionId, tool: req.toolName },
          });
        });
        resolve({ behavior: "deny", message: PARKED_DENY });
      });
      this.#held.set(permissionId, { resolve, cancel, agent });
    });
  }

  #allowedForTask(taskId: number, toolName: string): boolean {
    return (
      this.#deps.db.orm
        .select()
        .from(schema.permissionRequests)
        .where(
          and(
            eq(schema.permissionRequests.taskId, taskId),
            eq(schema.permissionRequests.toolName, toolName),
            eq(schema.permissionRequests.scope, "task"),
            eq(schema.permissionRequests.status, "allowed"),
          ),
        )
        .get() !== undefined
    );
  }

  /**
   * The owner pressed a button. If the turn is still held the decision reaches it at once and the
   * turn continues with no re-planning; otherwise the row is decided and the agent is woken with
   * the outcome in its next prompt.
   */
  settle(
    permissionId: number,
    decision: "allowed" | "denied",
    scope: "once" | "task",
    by: string,
  ): { landedInTime: boolean; agent: string | undefined } {
    const { db, clock } = this.#deps;
    const row = db.orm
      .select()
      .from(schema.permissionRequests)
      .where(eq(schema.permissionRequests.id, permissionId))
      .get();
    if (row?.status !== "pending") return { landedInTime: false, agent: undefined };

    const now = clock.now();
    db.orm.transaction((tx) => {
      tx.update(schema.permissionRequests)
        .set({ status: decision, decidedAt: now, scope })
        .where(eq(schema.permissionRequests.id, permissionId))
        .run();
      appendEvent(tx, {
        at: now,
        kind: `permission.${decision}`,
        payload: { permissionId, scope, by },
      });
    });

    const held = this.#held.get(permissionId);
    if (held) {
      this.#held.delete(permissionId);
      held.cancel();
      held.resolve(
        decision === "allowed"
          ? { behavior: "allow" }
          : {
              behavior: "deny",
              message: "Il proprietario ha negato. Non riprovare con una variante.",
            },
      );
      return { landedInTime: true, agent: held.agent };
    }

    // the turn ended parked; the outcome travels in the next prompt (# Esiti)
    const agent = db.orm
      .select({ agent: schema.turns.agent })
      .from(schema.turns)
      .where(eq(schema.turns.id, row.turnId))
      .get()?.agent;
    if (agent) this.#deps.wakeAgent(agent, "permission decided");
    return { landedInTime: false, agent };
  }

  /** An unanswered permission expires like any approval (spec section 10). */
  expire(): number[] {
    const { db, clock, holder } = this.#deps;
    const cutoff = clock.now() - holder.current.config.approvals.timeout_hours * 3_600_000;
    const expired: number[] = [];
    for (const row of db.orm
      .select()
      .from(schema.permissionRequests)
      .where(eq(schema.permissionRequests.status, "pending"))
      .all()) {
      if (row.createdAt > cutoff) continue;
      if (this.#held.has(row.id)) continue; // still inside its hold
      db.orm
        .update(schema.permissionRequests)
        .set({ status: "expired", decidedAt: clock.now() })
        .where(eq(schema.permissionRequests.id, row.id))
        .run();
      expired.push(row.id);
    }
    return expired;
  }

  /** Shutdown: every held turn is released with the parked deny, so nothing hangs. */
  releaseAll(): void {
    for (const [id, held] of this.#held) {
      held.cancel();
      held.resolve({ behavior: "deny", message: PARKED_DENY });
      this.#held.delete(id);
    }
  }
}
