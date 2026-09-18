// Slack input → inbox rows. The durable write comes first in every handler; classification
// follows. Two dedup keys: the transport id (event_id or trigger_id) and, for messages, the
// logical channel:ts (one mention can arrive twice with different ids).
import type { Clock } from "../ports/clock.js";
import type { Db } from "../store/db.js";
import { recordInbound } from "../store/inbox.js";

export type Inbound =
  | {
      kind: "owner_message";
      channel: string;
      threadTs: string | undefined;
      text: string;
      ts: string;
      user: string;
    }
  | { kind: "owner_reaction"; channel: string; ts: string; reaction: string }
  | { kind: "home_opened"; user: string }
  | { kind: "channel_archived"; channel: string }
  | { kind: "member_joined"; channel: string; user: string }
  | { kind: "bot_message_dropped" }
  | { kind: "ignored"; reason: string }
  | {
      kind: "button";
      actionId: string;
      value: string;
      renderId: number | undefined;
      epoch: number | undefined;
      selected: string | undefined;
      user: string;
      channel: string | undefined;
      ts: string | undefined;
      triggerId: string;
    }
  | {
      kind: "view_submitted";
      callbackId: string;
      viewId: string;
      metadata: unknown;
      values: Record<string, string | null>;
      user: string;
      triggerId: string;
    }
  | {
      kind: "command";
      name: string;
      text: string;
      channel: string;
      user: string;
      triggerId: string;
    };

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function classifyEvent(event: unknown, ownerUserId: string): Inbound {
  const e = rec(event);
  switch (e.type) {
    case "message": {
      if (e.bot_id !== undefined || e.subtype === "bot_message")
        return { kind: "bot_message_dropped" };
      if (e.subtype === "message_changed" || e.subtype === "message_deleted") {
        return {
          kind: "ignored",
          reason: `subtype ${String(e.subtype)}: the store is the history`,
        };
      }
      if (e.subtype !== undefined)
        return { kind: "ignored", reason: `subtype ${String(e.subtype)}` };
      if (e.user !== ownerUserId) return { kind: "ignored", reason: "not the owner" };
      const channel = str(e.channel);
      const ts = str(e.ts);
      if (!channel || !ts) return { kind: "ignored", reason: "message without channel or ts" };
      return {
        kind: "owner_message",
        channel,
        threadTs: str(e.thread_ts),
        text: str(e.text) ?? "",
        ts,
        user: ownerUserId,
      };
    }
    case "reaction_added": {
      if (e.user !== ownerUserId) return { kind: "ignored", reason: "not the owner" };
      const item = rec(e.item);
      const channel = str(item.channel);
      const ts = str(item.ts);
      if (!channel || !ts) return { kind: "ignored", reason: "reaction without item" };
      return { kind: "owner_reaction", channel, ts, reaction: str(e.reaction) ?? "" };
    }
    case "app_home_opened":
      return { kind: "home_opened", user: str(e.user) ?? "" };
    case "channel_archive":
      return { kind: "channel_archived", channel: str(e.channel) ?? "" };
    case "member_joined_channel":
      return { kind: "member_joined", channel: str(e.channel) ?? "", user: str(e.user) ?? "" };
    default:
      return { kind: "ignored", reason: `event type ${String(e.type)}` };
  }
}

export type Handled = { id: number; inserted: boolean; inbound: Inbound };

/** Events API envelope: { event_id, event }. Written first, classified after. */
export function handleEvent(db: Db, clock: Clock, ownerUserId: string, body: unknown): Handled {
  const b = rec(body);
  const event = rec(b.event);
  const eventId = str(b.event_id) ?? `event:${str(event.ts) ?? clock.now()}`;
  const channel = str(event.channel) ?? str(rec(event.item).channel);
  const ts = str(event.ts) ?? str(rec(event.item).ts);
  const logicalKey = event.type === "message" && channel && ts ? `${channel}:${ts}` : undefined;
  const r = recordInbound(db, clock, {
    eventId,
    ...(logicalKey ? { logicalKey } : {}),
    payload: body,
  });
  return { ...r, inbound: classifyEvent(event, ownerUserId) };
}

const parseValue = (value: string): { renderId: number | undefined; epoch: number | undefined } => {
  const m = /^(\d+)(?::(\d+))?$/.exec(value);
  if (!m) return { renderId: undefined, epoch: undefined };
  return { renderId: Number(m[1]), epoch: m[2] === undefined ? undefined : Number(m[2]) };
};

/** block_actions payload. The transport id is the trigger_id (unique per interaction). */
export function handleAction(db: Db, clock: Clock, body: unknown): Handled {
  const b = rec(body);
  const triggerId = str(b.trigger_id) ?? `action:${clock.now()}`;
  const r = recordInbound(db, clock, { eventId: `action:${triggerId}`, payload: body });
  const action = rec((b.actions as unknown[] | undefined)?.[0]);
  const selected = str(rec(action.selected_option).value);
  const value = str(action.value) ?? selected ?? "";
  const container = rec(b.container);
  return {
    ...r,
    inbound: {
      kind: "button",
      actionId: str(action.action_id) ?? "",
      value,
      ...parseValue(value),
      selected,
      user: str(rec(b.user).id) ?? "",
      channel: str(container.channel_id),
      ts: str(container.message_ts),
      triggerId,
    },
  };
}

/** view_submission payload: values flattened to block_id → string | null. */
export function handleView(db: Db, clock: Clock, body: unknown): Handled {
  const b = rec(body);
  const view = rec(b.view);
  const triggerId = str(b.trigger_id) ?? `view:${str(view.id) ?? clock.now()}`;
  const r = recordInbound(db, clock, { eventId: `view:${triggerId}`, payload: body });
  const values: Record<string, string | null> = {};
  for (const [blockId, actionsById] of Object.entries(rec(rec(view.state).values))) {
    const first = rec(Object.values(rec(actionsById))[0]);
    values[blockId] = str(first.value) ?? str(rec(first.selected_option).value) ?? null;
  }
  let metadata: unknown;
  try {
    metadata = view.private_metadata ? JSON.parse(String(view.private_metadata)) : undefined;
  } catch {
    metadata = undefined;
  }
  return {
    ...r,
    inbound: {
      kind: "view_submitted",
      callbackId: str(view.callback_id) ?? "",
      viewId: str(view.id) ?? "",
      metadata,
      values,
      user: str(rec(b.user).id) ?? "",
      triggerId,
    },
  };
}

/** slash command payload. */
export function handleCommand(db: Db, clock: Clock, body: unknown): Handled {
  const b = rec(body);
  const triggerId = str(b.trigger_id) ?? `command:${clock.now()}`;
  const r = recordInbound(db, clock, { eventId: `command:${triggerId}`, payload: body });
  return {
    ...r,
    inbound: {
      kind: "command",
      name: (str(b.command) ?? "").replace(/^\//, ""),
      text: (str(b.text) ?? "").trim(),
      channel: str(b.channel_id) ?? "",
      user: str(b.user_id) ?? "",
      triggerId,
    },
  };
}
