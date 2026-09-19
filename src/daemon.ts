// The daemon: one process that boots the store, the mirror and the scheduler, watches the home
// folder, answers /healthz, and shuts down in order (spec sections 3 and 13).
// --fake runs the whole company against fake-claude and FakeChat, so CI needs no Slack, no
// tokens and no real CLI.

import { mkdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FSWatcher, watch } from "chokidar";
import { eq } from "drizzle-orm";
import { DaemonActionsImpl } from "./actions/daemon-actions.js";
import { SnapshotHolder } from "./config/holder.js";
import { CliRunner } from "./engine/runner.js";
import { Approvals } from "./governance/approvals.js";
import { Guards, PlanLimits } from "./governance/guards.js";
import { PermissionBroker } from "./governance/permissions.js";
import type { AppName, Chat } from "./ports/chat.js";
import { type Clock, SystemClock } from "./ports/clock.js";
import { type Ids, SystemIds } from "./ports/ids.js";
import type { AgentRunner } from "./ports/runner.js";
import { SystemTimers, type Timers } from "./ports/timers.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { createSlackApps, type SlackApps } from "./slack/app.js";
import { ensureContainers } from "./slack/bootstrap.js";
import { dispatchButton, dispatchCommand, dispatchView } from "./slack/commands.js";
import { FakeChat } from "./slack/fake-chat.js";
import type { Inbound } from "./slack/inbox.js";
import { type Pump, startOutboxPump } from "./slack/outbox-pump.js";
import { openDatabase } from "./store/db.js";
import { appendEvent } from "./store/events.js";
import { appendMessage } from "./store/messages.js";
import * as schema from "./store/schema.js";

const WATCH_DEBOUNCE_MS = 300;
const DRAIN_MS = 120_000;

export type DaemonOptions = {
  home: string;
  /** fake-claude and FakeChat: a whole company with no Slack, no tokens and no real CLI */
  fake?: boolean;
  /** the fake CLI with the real Slack workspace, for the owner's by-hand pass */
  fakeCli?: boolean;
  healthPort?: number;
  clock?: Clock;
  ids?: Ids;
  timers?: Timers;
  log?(line: string, fields?: Record<string, unknown>): void;
};

export type Daemon = {
  holder: SnapshotHolder;
  scheduler: Scheduler;
  chat: Chat;
  health(): HealthReport;
  /**
   * What an owner message from Slack does, without Slack: the seam --fake needs, and the one
   * the end-to-end test drives. Routing is the real routing (spec section 6).
   */
  ownerSays(channel: string, text: string): void;
  stop(drainMs?: number): Promise<void>;
};

export type HealthReport = {
  ok: boolean;
  runningTurns: number;
  queueDepth: number;
  lastSlackEventAgeMs: number | null;
  walBytes: number;
  limitPausedUntil: number | null;
  configVersion: string;
};

const fakeClaude = fileURLToPath(new URL("../tools/fake-claude/fake-claude.mjs", import.meta.url));
const hookPath = fileURLToPath(new URL("../hooks/pre-tool-use.mjs", import.meta.url));

export async function startDaemon(o: DaemonOptions): Promise<Daemon> {
  const log = o.log ?? (() => {});
  const clock = o.clock ?? new SystemClock();
  const ids = o.ids ?? new SystemIds();
  const timers = o.timers ?? new SystemTimers();

  // 1. the store, migrated in a transaction by openDatabase; both folders are gitignored
  mkdirSync(join(o.home, "data"), { recursive: true });
  mkdirSync(join(o.home, "runs"), { recursive: true });
  const db = openDatabase(join(o.home, "data", "agentopolis.db"));
  // 2. the home folder; a malformed one refuses to boot at all
  const holder = SnapshotHolder.open(o.home);
  // 3. standing agents are folders; their rows mirror them
  upsertStandingAgents(db, holder, clock);

  // 4. the mirror
  const useFakeChat = o.fake === true;
  let slack: SlackApps | undefined;
  const fakeChat = useFakeChat ? new FakeChat() : undefined;
  let lastSlackEventAt: number | null = null;

  // the daemon's own pieces, wired to each other through small functions rather than a container
  const channelFor = (agent: string): string => containerFor(db, agent)?.slackChannel ?? "";
  const scheduler = new Scheduler({
    db,
    clock,
    ids,
    holder,
    runner: makeRunner(o, clock),
    runsDir: join(o.home, "runs"),
    hookPath,
    mayRun: (agent) => mayRun(agent),
    onPermission: (agent, turnId, req) => permissions.onPermission(agent, turnId, req),
    onRateLimit: (info) => limits.onRateLimit(info),
    log,
  });
  const wakeAgent = (agent: string, reason: string) => scheduler.wakeAgent(agent, reason);

  const approvals = new Approvals({ db, clock, holder, channelFor, wakeAgent });
  const permissions = new PermissionBroker({ db, clock, timers, holder, channelFor, wakeAgent });
  const guards = new Guards({
    db,
    clock,
    holder,
    systemNote: (agent, containerId, body) =>
      appendMessage(db, clock, { containerId, author: "daemon", to: agent, body, kind: "system" }),
    log,
  });
  const limits = new PlanLimits({
    db,
    clock,
    holder,
    ownerChannel: () => channelFor(ceoName(holder) ?? ""),
    onConcurrencyChange: (n) => scheduler.setConcurrency(n),
    log,
  });
  const actions = new DaemonActionsImpl({
    db,
    clock,
    ids,
    holder,
    approvals,
    permissions,
    guards,
    limits,
    wakeAgent,
    containerFor: (agent) => {
      const row = containerFor(db, agent);
      return row ? { id: row.id, slackChannel: row.slackChannel ?? "" } : undefined;
    },
    reload: () => holder.reload(),
    log,
  });

  /** Paused, limit-paused, blocked by the loop guard, or stuck on a refused rung. */
  function mayRun(agent: string): boolean {
    if (!limits.mayRun()) return false;
    if (actions.isPaused(agent)) return false;
    if (guards.taskIsBlocked(agent)) return false;
    if (guards.rungRefused(agent)) return false;
    return true;
  }

  if (!useFakeChat) {
    slack = createSlackApps({
      apps: tokensFor(holder),
      db,
      clock,
      ownerUserId: holder.current.config.slack.owner_user_id,
      onInbound: async (inbound) => {
        lastSlackEventAt = clock.now();
        return onInbound(inbound);
      },
      log,
    });
    await slack.start();
  }
  const realChat: Chat = slack?.chat ?? fakeChat ?? placeholderChat();

  async function onInbound(inbound: Inbound): Promise<unknown> {
    const ctx = {
      snapshot: holder.current,
      ownerUserId: holder.current.config.slack.owner_user_id,
    };
    switch (inbound.kind) {
      case "command":
        await dispatchCommand(inbound, actions, realChat, ctx);
        return undefined;
      case "button":
        await dispatchButton(inbound, actions, realChat, ctx);
        return undefined;
      case "view_submitted":
        return dispatchView(inbound, actions, realChat, ctx);
      case "owner_message":
        ownerSaid(db, clock, holder, scheduler, inbound);
        return undefined;
      case "home_opened":
        await realChat.publishHome(inbound.user, await actions.homeView(inbound.user));
        return undefined;
      default:
        return undefined;
    }
  }

  // 5. the containers the owner talks in; FakeChat opens them just as Slack does
  await ensureContainers(
    realChat,
    db,
    clock,
    holder.current,
    holder.current.config.slack.owner_user_id,
  );

  // 6. what a crash left behind
  const reaped = scheduler.reapOrphans();
  const interrupted = scheduler.markInterruptedTurns();
  if (interrupted.length || reaped.length) {
    log("recovered from a crash", { interrupted: interrupted.length, orphans: reaped.length });
  }

  // 7. the outbox, 8. the scheduler, 9. the watch
  const pump: Pump = startOutboxPump({
    db,
    chat: realChat,
    clock,
    snapshotOf: () => holder.current,
    log,
  });
  scheduler.startSchedules();
  scheduler.replayWakes();
  const watcher = await startWatch(o.home, holder, db, clock, log);

  // 10. /healthz, on localhost only
  const health = (): HealthReport => ({
    ok: true,
    runningTurns: scheduler.runningTurns,
    queueDepth: scheduler.queueDepth,
    lastSlackEventAgeMs: lastSlackEventAt === null ? null : clock.now() - lastSlackEventAt,
    walBytes: walBytes(o.home),
    limitPausedUntil: limits.pausedUntil,
    configVersion: holder.current.version,
  });
  const server = o.healthPort === undefined ? undefined : startHealth(o.healthPort, health);

  // 11. systemd, when it is listening
  notifyReady();
  log("daemon ready", { home: o.home, fake: o.fake === true, version: holder.current.version });

  return {
    holder,
    scheduler,
    chat: realChat,
    health,
    ownerSays: (channel, text) =>
      ownerSaid(db, clock, holder, scheduler, {
        kind: "owner_message",
        channel,
        text,
        ts: String(clock.now()),
        threadTs: undefined,
        user: holder.current.config.slack.owner_user_id,
      } as Extract<Inbound, { kind: "owner_message" }>),
    async stop(drainMs = DRAIN_MS) {
      await watcher?.close();
      await slack?.stop();
      permissions.releaseAll();
      await scheduler.stop(drainMs);
      await pump.stop();
      try {
        db.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // a closed or busy database at shutdown is not worth failing over
      }
      server?.close();
      db.close();
      log("daemon stopped");
    },
  };
}

// ---- boot pieces -------------------------------------------------------------------------------

function upsertStandingAgents(
  db: ReturnType<typeof openDatabase>,
  holder: SnapshotHolder,
  clock: Clock,
): void {
  for (const agent of holder.current.agents.values()) {
    const role = holder.current.roles.get(agent.role);
    db.orm
      .insert(schema.agents)
      .values({
        name: agent.name,
        role: agent.role,
        display: agent.display,
        project: agent.project ?? null,
        reportsTo: agent.reports_to,
        kind: role?.kind ?? "standing",
        paused: agent.paused,
      })
      .onConflictDoUpdate({
        target: schema.agents.name,
        set: {
          role: agent.role,
          display: agent.display,
          project: agent.project ?? null,
          reportsTo: agent.reports_to,
        },
      })
      .run();
  }
  db.orm.transaction((tx) => {
    appendEvent(tx, {
      at: clock.now(),
      kind: "daemon.booted",
      payload: { version: holder.current.version },
    });
  });
}

/** The owner typed in a container: route it exactly (spec section 6). */
function ownerSaid(
  db: ReturnType<typeof openDatabase>,
  clock: Clock,
  holder: SnapshotHolder,
  scheduler: Scheduler,
  inbound: Extract<Inbound, { kind: "owner_message" }>,
): void {
  const container = db.orm
    .select()
    .from(schema.containers)
    .where(eq(schema.containers.slackChannel, inbound.channel))
    .get();
  if (!container) return;
  // the member with the most recent open ask here, else the container's default addressee
  const openAsk = db.orm
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.containerId, container.id))
    .all()
    .filter((m) => m.kind === "ask" && m.to === "owner" && m.answeredBy === null)
    .at(-1);
  const to = openAsk?.author ?? container.defaultTo;
  const { messageId } = appendMessage(db, clock, {
    containerId: container.id,
    author: "owner",
    to,
    body: inbound.text,
    kind: "say",
  });
  if (openAsk) {
    db.orm
      .update(schema.messages)
      .set({ answeredBy: messageId })
      .where(eq(schema.messages.id, openAsk.id))
      .run();
  }
  void holder;
  scheduler.wakeAgent(to, "the owner wrote");
}

function containerFor(db: ReturnType<typeof openDatabase>, agent: string) {
  const rows = db.orm.select().from(schema.containers).all();
  return (
    rows.find((c) => c.kind === "dm" && c.members.includes(agent)) ??
    rows.find((c) => c.members.includes(agent))
  );
}

const ceoName = (holder: SnapshotHolder): string | undefined =>
  [...holder.current.agents.values()].find((a) => a.role === "ceo")?.name;

function tokensFor(holder: SnapshotHolder): Record<AppName, { token: string; appToken: string }> {
  const out: Record<AppName, { token: string; appToken: string }> = {};
  for (const [name, app] of Object.entries(holder.current.config.slack.apps)) {
    const token = process.env[app.bot_token_env];
    const appToken = process.env[app.app_token_env];
    if (!token || !appToken) {
      throw new Error(`Slack app "${name}" needs ${app.bot_token_env} and ${app.app_token_env}`);
    }
    out[name] = { token, appToken };
  }
  return out;
}

function makeRunner(o: DaemonOptions, clock: Clock): AgentRunner {
  const runsDir = join(o.home, "runs");
  if (o.fake === true || o.fakeCli === true) {
    return new CliRunner({
      claudePath: process.execPath,
      claudeArgs: [fakeClaude],
      runsDir,
      clock,
    });
  }
  return new CliRunner({ claudePath: "claude", runsDir, clock });
}

/**
 * A prose edit reaches the agent on its next turn because the daemon re-reads the folder; a
 * malformed file is rejected and the last good snapshot stays loaded (spec section 13).
 */
async function startWatch(
  home: string,
  holder: SnapshotHolder,
  db: ReturnType<typeof openDatabase>,
  clock: Clock,
  log: (line: string, fields?: Record<string, unknown>) => void,
): Promise<FSWatcher> {
  // data/ and runs/ are gitignored and churn constantly (the WAL, the per-turn streams). They
  // must be excluded by prefix, directory included: a path check that only matched "/data/" left
  // chokidar watching the WAL and reloading the whole folder on every write.
  const excluded = [join(home, "data"), join(home, "runs")];
  const watcher = watch(home, {
    ignored: (path) => excluded.some((dir) => path === dir || path.startsWith(`${dir}/`)),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: WATCH_DEBOUNCE_MS, pollInterval: 50 },
  });
  const reload = () => {
    const r = holder.reload();
    if (r.ok) {
      if (r.changed) {
        db.orm.transaction((tx) => {
          appendEvent(tx, {
            at: clock.now(),
            kind: "config.reloaded",
            payload: { version: holder.current.version },
          });
        });
        log("home folder reloaded", { version: holder.current.version });
      }
      return;
    }
    // the last good snapshot stays; the ceo is told which file and why
    db.orm.transaction((tx) => {
      appendEvent(tx, { at: clock.now(), kind: "config.rejected", payload: { errors: r.errors } });
    });
    const ceo = [...holder.current.agents.values()].find((a) => a.role === "ceo");
    const container = ceo ? containerFor(db, ceo.name) : undefined;
    if (ceo && container) {
      appendMessage(db, clock, {
        containerId: container.id,
        author: "daemon",
        to: ceo.name,
        body: `Ho rifiutato una modifica alla cartella: ${r.errors
          .map((e) => `${e.file}: ${e.message}`)
          .join("; ")
          .slice(0, 1_500)}`,
        kind: "system",
      });
    }
    log("home folder rejected", { errors: r.errors.length });
  };
  watcher.on("all", reload);
  // boot is not finished until the watcher is live: a prose edit written a millisecond after
  // "daemon ready" must still reach the next turn, and chokidar misses writes during its scan
  await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
  return watcher;
}

function walBytes(home: string): number {
  try {
    return statSync(join(home, "data", "agentopolis.db-wal")).size;
  } catch {
    return 0;
  }
}

function startHealth(port: number, health: () => HealthReport): Server {
  const server = createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.stringify(health());
    res.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  server.listen(port, "127.0.0.1");
  server.unref();
  return server;
}

/**
 * systemd's Type=notify wants READY=1 on a unix datagram socket, which Node cannot open without
 * a native module. The unit and its watchdog are slice 7's job (roadmap), so this is a no-op
 * here and the daemon runs perfectly well under Type=simple in the meantime.
 */
function notifyReady(): void {
  if (!process.env.NOTIFY_SOCKET) return;
}

/** Until the Slack apps exist, nothing may be posted; the outbox simply waits. */
function placeholderChat(): Chat {
  const fail = async (): Promise<never> => {
    throw new Error("the Slack apps are not started yet");
  };
  return new Proxy({} as Chat, { get: () => fail }) as Chat;
}
