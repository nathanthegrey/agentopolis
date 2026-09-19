// What the owner can make the daemon do, and what the dispatcher reads to render (spec section 9).
// Every one of these is a daemon action, never an agent turn: they cost nothing and they are the
// only way anything in the company changes from Slack.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import { stringify as toYaml } from "yaml";
import type { SnapshotHolder } from "../config/holder.js";
import type { Approvals } from "../governance/approvals.js";
import { markAnswered, renderPayload, rewriteCard } from "../governance/cards.js";
import type { Guards, PlanLimits } from "../governance/guards.js";
import type { PermissionBroker } from "../governance/permissions.js";
import type { Clock } from "../ports/clock.js";
import type { Ids } from "../ports/ids.js";
import { type EditableFile, homeView } from "../slack/blocks.js";
import type { ActionResult, Daemon, HireForm } from "../slack/commands.js";
import { S } from "../slack/strings.js";
import type { Db } from "../store/db.js";
import { appendEvent } from "../store/events.js";
import { appendMessage } from "../store/messages.js";
import * as schema from "../store/schema.js";

const ok: ActionResult = { ok: true };
const no = (reason: string): ActionResult => ({ ok: false, reason });

export type DaemonActionsDeps = {
  db: Db;
  clock: Clock;
  ids: Ids;
  holder: SnapshotHolder;
  approvals: Approvals;
  permissions: PermissionBroker;
  guards: Guards;
  limits: PlanLimits;
  wakeAgent(agent: string, reason: string): void;
  /** the agent's own container with the owner: its DM, or the project's -hq channel */
  containerFor(agent: string): { id: number; slackChannel: string } | undefined;
  /** re-read the home folder after a write, so the next turn sees the edit */
  reload(): void;
  log?(line: string, fields?: Record<string, unknown>): void;
};

export class DaemonActionsImpl implements Daemon {
  readonly #deps: DaemonActionsDeps;

  constructor(deps: DaemonActionsDeps) {
    this.#deps = deps;
  }

  // ---- hiring and prose -------------------------------------------------------------------

  async hire(form: HireForm): Promise<ActionResult> {
    const { db, clock, holder } = this.#deps;
    const snapshot = holder.current;
    const role = snapshot.roles.get(form.role);
    if (!role) return no(`il ruolo ${form.role} non esiste`);
    if (role.kind !== "standing") return no("gli agenti a compito nascono con il compito");

    const name = slugify(form.display);
    if (snapshot.agents.has(name)) return no(`${name} esiste già`);
    const app = snapshot.config.slack.apps[name];
    if (!app) return no(`config.yaml non elenca un'app Slack chiamata ${name}`);
    for (const envName of [app.bot_token_env, app.app_token_env]) {
      if (!process.env[envName]) return no(`manca ${envName} nell'ambiente`);
    }

    const dir = join(snapshot.dir, "agents", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "agent.yaml"),
      toYaml({
        name,
        display: form.display,
        role: form.role,
        ...(form.project ? { project: form.project } : {}),
        reports_to: standingLead(snapshot) ?? "owner",
        slack_app: name,
        ...(form.model ? { model: form.model } : {}),
      }),
    );
    writeFileSync(join(dir, "MEMORY.md"), "");
    this.#deps.reload();

    const now = clock.now();
    db.orm.transaction((tx) => {
      tx.insert(schema.agents)
        .values({
          name,
          role: form.role,
          display: form.display,
          project: form.project ?? null,
          reportsTo: standingLead(snapshot) ?? null,
          kind: "standing",
        })
        .onConflictDoNothing()
        .run();
      appendEvent(tx, { at: now, kind: "agent.hired", agent: name, payload: { ...form } });
    });
    return ok;
  }

  async edit(agent: string, file: EditableFile, text: string): Promise<ActionResult> {
    const { db, clock, holder } = this.#deps;
    if (file !== "MEMORY.md") {
      // the role's prose is three files since slice 1 (SOUL.md, JOB.md, PROTOCOL.md); which of
      // them /edit exposes is slice 5's call, because slice 5 owns the prose
      return no("la prosa del ruolo è in SOUL.md, JOB.md e PROTOCOL.md: si modifica in git");
    }
    const path = join(holder.current.dir, "agents", agent, file);
    if (!holder.current.agents.has(agent)) return no(`non conosco ${agent}`);
    const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
    writeFileSync(path, text);
    this.#deps.reload();
    db.orm.transaction((tx) => {
      appendEvent(tx, {
        at: clock.now(),
        kind: "file.edited",
        agent,
        payload: { file, path, previous },
      });
    });
    return ok;
  }

  async undoEdit(agent: string): Promise<ActionResult> {
    const { db, clock } = this.#deps;
    const last = db.orm
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.kind, "file.edited"), eq(schema.events.agent, agent)))
      .orderBy(desc(schema.events.id))
      .get();
    if (!last) return no(`nessuna modifica da annullare per ${agent}`);
    const payload = last.payload as { path: string; previous: string; file: string };
    writeFileSync(payload.path, payload.previous);
    this.#deps.reload();
    db.orm.transaction((tx) => {
      appendEvent(tx, {
        at: clock.now(),
        kind: "file.edit_undone",
        agent,
        payload: { file: payload.file },
      });
    });
    return ok;
  }

  // ---- the agent's own state ----------------------------------------------------------------

  async pause(agent: string): Promise<ActionResult> {
    return this.#setPaused(agent, true);
  }

  async resume(agent: string): Promise<ActionResult> {
    const r = await this.#setPaused(agent, false);
    if (r.ok) this.#deps.wakeAgent(agent, "resumed by the owner");
    return r;
  }

  async #setPaused(agent: string, paused: boolean): Promise<ActionResult> {
    const { db, clock } = this.#deps;
    if (!this.#known(agent)) return no(`non conosco ${agent}`);
    this.#upsert(agent);
    db.orm.transaction((tx) => {
      tx.update(schema.agents).set({ paused }).where(eq(schema.agents.name, agent)).run();
      appendEvent(tx, {
        at: clock.now(),
        kind: paused ? "agent.paused" : "agent.resumed",
        agent,
        payload: {},
      });
    });
    this.#note(agent, paused ? S.done.paused(agent) : S.done.resumed(agent));
    return ok;
  }

  /** A paused agent gets no turns; the pending set simply waits (spec section 10). */
  isPaused(agent: string): boolean {
    const row = this.#deps.db.orm
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.name, agent))
      .get();
    return row?.paused ?? this.#deps.holder.current.agents.get(agent)?.paused ?? false;
  }

  async setModel(agent: string, model: string): Promise<ActionResult> {
    const { db, clock, holder } = this.#deps;
    if (!this.#known(agent)) return no(`non conosco ${agent}`);
    // the owner can always set any value directly from the Home tab, no card (A3)
    this.#upsert(agent);
    const path = join(holder.current.dir, "agents", agent, "agent.yaml");
    if (existsSync(path)) {
      const file = holder.current.agents.get(agent);
      if (file) writeFileSync(path, toYaml({ ...file, model, session_id: null }));
      this.#deps.reload();
    }
    // a mid-session model switch invalidates the whole cache, so the change starts a session (A2)
    db.orm.transaction((tx) => {
      tx.update(schema.agents)
        .set({ sessionId: null, sessionStartedAt: null })
        .where(eq(schema.agents.name, agent))
        .run();
      appendEvent(tx, { at: clock.now(), kind: "agent.model_set", agent, payload: { model } });
    });
    this.#note(agent, S.done.model(agent, model));
    return ok;
  }

  /** A fresh session; MEMORY.md is kept (spec section 9). */
  async restart(agent: string): Promise<ActionResult> {
    const { db, clock } = this.#deps;
    if (!this.#known(agent)) return no(`non conosco ${agent}`);
    this.#upsert(agent);
    db.orm.transaction((tx) => {
      tx.update(schema.agents)
        .set({ sessionId: null, sessionStartedAt: null })
        .where(eq(schema.agents.name, agent))
        .run();
      appendEvent(tx, { at: clock.now(), kind: "agent.restarted", agent, payload: {} });
    });
    this.#note(agent, S.done.restarted(agent));
    return ok;
  }

  async retire(agent: string): Promise<ActionResult> {
    const { db, clock } = this.#deps;
    if (!this.#known(agent)) return no(`non conosco ${agent}`);
    this.#upsert(agent);
    const now = clock.now();
    db.orm.transaction((tx) => {
      tx.update(schema.agents)
        .set({ retiredAt: now, paused: true })
        .where(eq(schema.agents.name, agent))
        .run();
      appendEvent(tx, { at: now, kind: "agent.retired", agent, payload: {} });
    });
    this.#note(agent, S.done.retired(agent));
    return ok;
  }

  /** The last turn, for /diag: what happened, and where to read the raw stream. */
  async diag(agent: string): Promise<string> {
    const turn = this.#deps.db.orm
      .select()
      .from(schema.turns)
      .where(eq(schema.turns.agent, agent))
      .orderBy(desc(schema.turns.id))
      .get();
    if (!turn) return `${agent}: nessun turno finora.`;
    const lines = [
      `${agent} · turno #${turn.id} · ${turn.status}`,
      `sessione ${turn.sessionId} · configurazione ${turn.configVersion.slice(0, 12)}`,
      turn.costMicrousd === null
        ? "costo sconosciuto"
        : `costo ${(turn.costMicrousd / 1_000_000).toFixed(2)} $ stimato`,
      turn.error ? `errore: ${turn.error.slice(0, 500)}` : "nessun errore",
    ];
    return lines.join("\n");
  }

  /** A parked discovery becomes the lead's problem, not a task the daemon opens by itself. */
  async openParked(taskId: number): Promise<ActionResult> {
    const { db, clock } = this.#deps;
    const task = db.orm.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    if (task?.status !== "parked") return no("questa non è una scoperta parcheggiata");
    db.orm.transaction((tx) => {
      appendEvent(tx, { at: clock.now(), kind: "task.unparked", payload: { taskId } });
    });
    this.#note(
      task.lead,
      `Il proprietario vuole aprire la parcheggiata «${task.title}». Apri il compito quando puoi.`,
    );
    this.#deps.wakeAgent(task.lead, "parked opened");
    return ok;
  }

  // ---- answers and decisions -----------------------------------------------------------------

  async answer(renderId: number, index: number, user: string): Promise<ActionResult> {
    const { db, clock } = this.#deps;
    const payload = renderPayload(db, renderId);
    if (payload?.subject.kind !== "ask") return no("unknown");
    const chosen = payload.options?.[index];
    if (chosen === undefined) return no("unknown");
    const posted = this.#answerAsk(payload.subject.id, chosen);
    if (!posted.ok) return posted;
    markAnswered(db, clock, renderId, chosen, "owner");
    this.#deps.wakeAgent(payload.agent, "the owner answered");
    void user;
    return ok;
  }

  async reply(renderId: number, text: string, user: string): Promise<ActionResult> {
    const { db, clock } = this.#deps;
    const payload = renderPayload(db, renderId);
    if (payload?.subject.kind !== "ask") return no("unknown");
    const posted = this.#answerAsk(payload.subject.id, text);
    if (!posted.ok) return posted;
    markAnswered(db, clock, renderId, text.slice(0, 60), "owner");
    this.#deps.wakeAgent(payload.agent, "the owner replied");
    void user;
    return ok;
  }

  /** The owner's reply is routed to exactly the message that asked (spec section 6). */
  #answerAsk(messageId: number, body: string): ActionResult {
    const { db, clock } = this.#deps;
    const ask = db.orm
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .get();
    if (!ask) return no("unknown");
    const { messageId: reply } = appendMessage(db, clock, {
      containerId: ask.containerId,
      author: "owner",
      to: ask.author,
      body,
      kind: "say",
    });
    db.orm
      .update(schema.messages)
      .set({ answeredBy: reply })
      .where(and(eq(schema.messages.id, messageId), isNull(schema.messages.answeredBy)))
      .run();
    return ok;
  }

  async approve(
    renderId: number,
    epoch: number,
    scope: "once" | "task",
    user: string,
  ): Promise<ActionResult> {
    return this.#decide(renderId, epoch, "approve", scope, user);
  }

  async deny(renderId: number, epoch: number, user: string): Promise<ActionResult> {
    return this.#decide(renderId, epoch, "deny", "once", user);
  }

  #decide(
    renderId: number,
    epoch: number,
    decision: "approve" | "deny",
    scope: "once" | "task",
    user: string,
  ): ActionResult {
    const { db, clock } = this.#deps;
    const payload = renderPayload(db, renderId);
    if (!payload) return no("unknown");
    if (payload.epoch !== epoch) return no("stale");
    if (payload.subject.kind === "permission") {
      const r = this.#deps.permissions.settle(
        payload.subject.id,
        decision === "approve" ? "allowed" : "denied",
        scope,
        user,
      );
      if (r.agent === undefined && !r.landedInTime) return no("stale");
    } else if (payload.subject.kind === "request") {
      const changed = this.#deps.approvals.decide(
        payload.subject.id,
        decision === "approve" ? "approved" : "denied",
        user,
      );
      if (!changed) return no("stale");
    } else {
      return no("unknown");
    }
    rewriteCard(db, clock, renderId, decision === "approve" ? "approvato" : "negato", user);
    return ok;
  }

  // ---- reads ----------------------------------------------------------------------------------

  async currentText(agent: string, file: EditableFile): Promise<string> {
    const path = join(this.#deps.holder.current.dir, "agents", agent, file);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  async details(renderId: number): Promise<unknown> {
    return renderPayload(this.#deps.db, renderId)?.details ?? {};
  }

  async homeView(_user: string): Promise<unknown> {
    const { db, clock, holder } = this.#deps;
    const now = clock.now();
    const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
    const turns = db.orm
      .select()
      .from(schema.turns)
      .all()
      .filter((t) => t.startedAt >= monthStart);
    const spentBy = new Map<string, number>();
    for (const t of turns) {
      spentBy.set(t.agent, (spentBy.get(t.agent) ?? 0) + (t.costMicrousd ?? 0));
    }

    const waiting: { text: string; renderId: number }[] = [];
    for (const r of db.orm.select().from(schema.renders).all()) {
      const payload = r.payload as { card?: { text?: string }; subject?: { kind: string } };
      if (!payload.subject) continue;
      const open =
        payload.subject.kind === "ask"
          ? !db.orm
              .select()
              .from(schema.events)
              .where(eq(schema.events.kind, "ask.answered"))
              .all()
              .some((e) => (e.payload as { renderId?: number }).renderId === r.id)
          : !db.orm
              .select()
              .from(schema.events)
              .where(eq(schema.events.kind, "card.decided"))
              .all()
              .some((e) => (e.payload as { renderId?: number }).renderId === r.id);
      if (open) waiting.push({ text: payload.card?.text ?? "", renderId: r.id });
    }

    const agents = [...holder.current.agents.values()].map((a) => ({
      name: a.name,
      display: a.display,
      state: this.isPaused(a.name) ? "in pausa" : "in corso",
      spentMicro: spentBy.get(a.name) ?? 0,
    }));

    return homeView({
      month: new Date(now).toISOString().slice(0, 7),
      spentMicro: [...spentBy.values()].reduce((a, b) => a + b, 0),
      waiting: waiting.slice(0, 5),
      projects: [...holder.current.projects.values()].map((p) => ({
        slug: p.slug,
        name: p.name,
        channel: p.slug,
      })),
      agents,
      parked: db.orm
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.status, "parked"))
        .all()
        .map((t) => ({ taskId: t.id, text: t.title })),
      updatedAt: now,
    });
  }

  // ---- helpers ---------------------------------------------------------------------------------

  #known(agent: string): boolean {
    return (
      this.#deps.holder.current.agents.has(agent) ||
      this.#deps.db.orm.select().from(schema.agents).where(eq(schema.agents.name, agent)).get() !==
        undefined
    );
  }

  /** A standing agent may have no row yet: its folder is the truth until its first turn. */
  #upsert(agent: string): void {
    const { db, holder } = this.#deps;
    const file = holder.current.agents.get(agent);
    if (!file) return;
    db.orm
      .insert(schema.agents)
      .values({
        name: agent,
        role: file.role,
        display: file.display,
        project: file.project ?? null,
        reportsTo: file.reports_to,
        kind: "standing",
        paused: file.paused,
      })
      .onConflictDoNothing()
      .run();
  }

  #note(agent: string, body: string): void {
    const container = this.#deps.containerFor(agent);
    if (!container) return;
    appendMessage(this.#deps.db, this.#deps.clock, {
      containerId: container.id,
      author: "daemon",
      to: agent,
      body,
      kind: "system",
    });
  }
}

const slugify = (display: string): string =>
  (display.split("·")[0] ?? display)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const standingLead = (snapshot: SnapshotHolder["current"]): string | undefined =>
  [...snapshot.agents.values()].find((a) => a.role === "ceo")?.name;
