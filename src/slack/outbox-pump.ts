// Drains outbox rows into Slack: one send per second per channel, bounded retries. Identity
// (spec section 9, one app per standing agent): a standing agent posts through its own app
// as itself; a job agent posts through its lead's app as a persona (username/icon_url); the
// daemon's own lines and every card go through the company app; a DM is always served by
// the app that owns it. A row is never dropped: a permanent Slack error marks it done with a
// mirror.failed event; anything else is retried.
import { eq } from "drizzle-orm";
import type { Snapshot } from "../config/loader.js";
import type { AgentFile } from "../config/schemas.js";
import { type AppName, type Chat, ChatError, COMPANY_APP, type Persona } from "../ports/chat.js";
import type { Clock } from "../ports/clock.js";
import type { Db } from "../store/db.js";
import { appendEvent } from "../store/events.js";
import { markDone, markHeld, markRetry, nextOutbox, type OutboxRow } from "../store/outbox.js";
import * as schema from "../store/schema.js";
import { LIMITS } from "./limits.js";
import { postAsPersona } from "./persona.js";

export type PumpOptions = {
  db: Db;
  chat: Chat;
  clock: Clock;
  snapshotOf: () => Snapshot;
  tickMs?: number;
  log: (line: string, extra?: Record<string, unknown>) => void;
};
export type Pump = { stop(): Promise<void>; tick(): Promise<number> };

const BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000];
const HOLD_MS = 30_000;
const PERMANENT = new Set([
  "channel_not_found",
  "is_archived",
  "not_in_channel",
  "invalid_blocks",
  "msg_too_long",
]);
const BATCH = 50;

type Outcome = { done: true; slackTs: string | null } | { hold: true };
type Container = typeof schema.containers.$inferSelect;

/** Which app speaks, and as whom (spec section 9). */
export function identityFor(
  author: string,
  kind: string,
  container: Container | undefined,
  snapshot: Snapshot,
): { as: AppName; persona: Persona | undefined } {
  const dmApp = (): AppName | undefined =>
    container?.kind === "dm" ? snapshot.agents.get(container.defaultTo)?.slack_app : undefined;
  if (kind === "system" || author === "owner")
    return { as: dmApp() ?? COMPANY_APP, persona: undefined };
  const agent = snapshot.agents.get(author);
  if (!agent) return { as: dmApp() ?? COMPANY_APP, persona: undefined };
  if (agent.slack_app) return { as: agent.slack_app, persona: undefined }; // a standing agent, as itself
  // a job agent: through the nearest standing ancestor's app, as a persona
  let up: AgentFile | undefined = snapshot.agents.get(agent.reports_to);
  for (let i = 0; up && !up.slack_app && i < 8; i += 1) up = snapshot.agents.get(up.reports_to);
  const persona: Persona = {
    username: agent.display,
    ...(agent.avatar ? { iconUrl: agent.avatar } : {}),
  };
  return { as: up?.slack_app ?? dmApp() ?? COMPANY_APP, persona };
}

export function startOutboxPump(opts: PumpOptions): Pump {
  const { db, chat, clock } = opts;
  const lastSentAt = new Map<string, number>();
  const held = new Set<number>();
  let inFlight: Promise<number> | null = null;

  const finishDone = (
    row: OutboxRow,
    slackTs: string | null,
    event?: { kind: string; agent?: string; payload: unknown },
  ) => {
    const now = clock.now();
    db.orm.transaction((tx) => {
      markDone(tx, row.id, slackTs, now);
      if (event)
        appendEvent(tx, {
          at: now,
          kind: event.kind,
          ...(event.agent ? { agent: event.agent } : {}),
          payload: event.payload,
        });
    });
  };
  const appOf = (payload: Record<string, unknown>): AppName =>
    typeof payload.as === "string" ? payload.as : COMPANY_APP;

  const send = async (row: OutboxRow): Promise<Outcome> => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const snapshot = opts.snapshotOf();
    switch (row.kind) {
      case "mirror.message": {
        const message = db.orm
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.id, Number(payload.messageId)))
          .get();
        if (!message)
          throw new ChatError(`message ${String(payload.messageId)} does not exist`, "row_missing");
        const container = db.orm
          .select()
          .from(schema.containers)
          .where(eq(schema.containers.id, message.containerId))
          .get();
        const channel = container?.slackChannel ?? row.channel;
        if (!channel) return { hold: true };
        // every ask to the owner mentions him; no hourly counter and no quiet hours:
        // notification timing is Slack's (revised plan, Task 5)
        const mention =
          message.kind === "ask" && message.to === "owner"
            ? snapshot.config.slack.owner_user_id
            : undefined;
        const text = mention ? `<@${mention}> ${message.body}` : message.body;
        const { as, persona } = identityFor(message.author, message.kind, container, snapshot);
        const base = {
          channel,
          text,
          as,
          ...(container?.slackThreadTs ? { threadTs: container.slackThreadTs } : {}),
        };
        const posted = persona
          ? await postAsPersona(chat, { ...base, persona })
          : await chat.post(base);
        lastSentAt.set(channel, clock.now());
        finishDone(row, posted.ts, {
          kind: "mirror.sent",
          agent: message.author,
          payload: { messageId: message.id, channel, slackTs: posted.ts, as },
        });
        return { done: true, slackTs: posted.ts };
      }
      case "card.post": {
        const posted = await chat.post({
          channel: row.channel,
          text: String(payload.text ?? ""),
          as: appOf(payload),
          ...(Array.isArray(payload.blocks) ? { blocks: payload.blocks } : {}),
          ...(payload.threadTs ? { threadTs: String(payload.threadTs) } : {}),
        });
        lastSentAt.set(row.channel, clock.now());
        finishDone(row, posted.ts);
        return { done: true, slackTs: posted.ts };
      }
      case "card.update": {
        await chat.update({
          channel: row.channel,
          ts: String(payload.ts),
          text: String(payload.text ?? ""),
          as: appOf(payload),
          ...(Array.isArray(payload.blocks) ? { blocks: payload.blocks } : {}),
        });
        lastSentAt.set(row.channel, clock.now());
        finishDone(row, String(payload.ts));
        return { done: true, slackTs: String(payload.ts) };
      }
      case "home.publish": {
        await chat.publishHome(String(payload.user), payload.view, COMPANY_APP);
        finishDone(row, null);
        return { done: true, slackTs: null };
      }
      case "channel.create": {
        const created = await chat.createPrivateChannel(String(payload.name), COMPANY_APP);
        if (Array.isArray(payload.invite) && payload.invite.length)
          await chat.invite(created.id, payload.invite.map(String), COMPANY_APP);
        if (payload.topic) await chat.setTopic(created.id, String(payload.topic), COMPANY_APP);
        finishDone(row, created.id, {
          kind: "channel.created",
          payload: { name: payload.name, channel: created.id },
        });
        return { done: true, slackTs: created.id };
      }
      case "channel.archive": {
        await chat.archive(row.channel, COMPANY_APP);
        finishDone(row, null, { kind: "channel.archived", payload: { channel: row.channel } });
        return { done: true, slackTs: null };
      }
      case "status.set": {
        if (chat.setSessionStatus) {
          await chat.setSessionStatus({
            channel: row.channel,
            status: payload.status === "processing" ? "processing" : "active",
            as: appOf(payload),
            ...(payload.threadTs ? { threadTs: String(payload.threadTs) } : {}),
            ...(payload.persona ? { persona: payload.persona as Persona } : {}),
          });
        }
        finishDone(row, null);
        return { done: true, slackTs: null };
      }
      default:
        throw new ChatError(`unknown outbox kind ${row.kind}`, "unknown_kind");
    }
  };

  const handle = async (row: OutboxRow): Promise<boolean> => {
    const now = clock.now();
    const last = lastSentAt.get(row.channel);
    if (row.channel && last !== undefined && now - last < 1000 / LIMITS.msgPerSecondPerChannel)
      return false;
    try {
      const r = await send(row);
      if ("hold" in r) {
        if (!held.has(row.id)) {
          held.add(row.id);
          db.orm.transaction((tx) => {
            markHeld(tx, row.id, now + HOLD_MS);
            appendEvent(tx, {
              at: now,
              kind: "mirror.held",
              payload: { outboxId: row.id, reason: "container has no channel yet" },
            });
          });
        } else {
          db.orm.transaction((tx) => markHeld(tx, row.id, now + HOLD_MS));
        }
        return false;
      }
      return true;
    } catch (e) {
      const err = e instanceof ChatError ? e : new ChatError((e as Error).message, "exception");
      if (PERMANENT.has(err.code)) {
        db.orm.transaction((tx) => {
          markDone(tx, row.id, null, now);
          appendEvent(tx, {
            at: now,
            kind: "mirror.failed",
            payload: {
              outboxId: row.id,
              kind: row.kind,
              channel: row.channel,
              error: err.code,
              message: err.message,
            },
          });
        });
        opts.log("outbox row failed permanently", { id: row.id, kind: row.kind, error: err.code });
        return false;
      }
      const delay =
        err.retryAfterMs ?? BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)] ?? 600_000;
      db.orm.transaction((tx) => markRetry(tx, row.id, now + delay));
      opts.log("outbox row retried", { id: row.id, kind: row.kind, error: err.code, inMs: delay });
      return false;
    }
  };

  const runTick = async (): Promise<number> => {
    let sent = 0;
    for (const row of nextOutbox(db, clock.now(), BATCH)) if (await handle(row)) sent += 1;
    return sent;
  };
  const tick = (): Promise<number> => {
    if (inFlight) return inFlight;
    inFlight = runTick().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  const timer = opts.tickMs ? setInterval(() => void tick(), opts.tickMs) : undefined;
  return {
    tick,
    async stop() {
      if (timer) clearInterval(timer);
      if (inFlight) await inFlight.catch(() => 0);
    },
  };
}
