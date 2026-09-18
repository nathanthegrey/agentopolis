// The Bolt App in Socket Mode and its listeners.
//
// Ack finding (Bolt 5.1.0, dist/App.js "Events API requests are acknowledged right away"):
// Events API events are acknowledged by Bolt BEFORE the listener chain runs, so for events
// "ack after durable write" is not available; the durable write is the listener's first
// statement and the two dedup keys cover Slack's redeliveries. Actions, view submissions and
// slash commands receive `ack` and are acknowledged only after the inbox row exists.
import { App, LogLevel } from "@slack/bolt";
import type { Clock } from "../ports/clock.js";
import type { Db } from "../store/db.js";
import { BoltChat, CLIENT_OPTIONS, type SlackClient } from "./bolt-chat.js";
import { handleAction, handleCommand, handleEvent, handleView, type Inbound } from "./inbox.js";

export type SlackAppOptions = {
  token: string;
  appToken: string;
  db: Db;
  clock: Clock;
  ownerUserId: string;
  /** returns a value only for view submissions that must be acked with an errors response */
  onInbound: (
    inbound: Inbound,
    ctx: { inboxId: number; inserted: boolean },
  ) => Promise<unknown> | unknown;
  log?: (line: string, extra?: Record<string, unknown>) => void;
  /** tests: skip auth.test and the socket; listeners are driven with app.processEvent */
  offline?: { botId: string; botUserId: string };
};

export type SlackApp = { app: App; chat: BoltChat; start(): Promise<void>; stop(): Promise<void> };

export function createSlackApp(o: SlackAppOptions): SlackApp {
  const log = o.log ?? (() => {});
  const offline = o.offline;
  const app = new App({
    ...(offline
      ? {
          authorize: async () => ({
            botId: offline.botId,
            botUserId: offline.botUserId,
            botToken: o.token,
          }),
        }
      : { token: o.token }),
    appToken: o.appToken,
    socketMode: true,
    clientOptions: CLIENT_OPTIONS,
    logLevel: LogLevel.WARN,
    ignoreSelf: true,
  });
  const chat = new BoltChat(app.client as unknown as SlackClient);

  const deliver = async (h: {
    id: number;
    inserted: boolean;
    inbound: Inbound;
  }): Promise<unknown> => {
    try {
      return await o.onInbound(h.inbound, { inboxId: h.id, inserted: h.inserted });
    } catch (e) {
      log("onInbound failed", { inboxId: h.id, error: (e as Error).message });
      return undefined;
    }
  };

  for (const type of [
    "message",
    "reaction_added",
    "app_home_opened",
    "member_joined_channel",
    "channel_archive",
  ]) {
    app.event(type, async ({ body }) => {
      const h = handleEvent(o.db, o.clock, o.ownerUserId, body); // durable first; Bolt already acked
      await deliver(h);
    });
  }
  app.action(/.*/, async ({ body, ack }) => {
    const h = handleAction(o.db, o.clock, body); // durable first
    await ack();
    await deliver(h);
  });
  app.view(/.*/, async ({ body, ack }) => {
    const h = handleView(o.db, o.clock, body); // durable first
    // a view is acked with its validation result, so dispatch runs between write and ack
    const response = await deliver(h);
    const ackWith = ack as unknown as (response?: unknown) => Promise<void>;
    await (response ? ackWith(response) : ack());
  });
  app.command(/\/.*/, async ({ body, ack }) => {
    const h = handleCommand(o.db, o.clock, body); // durable first
    await ack();
    await deliver(h);
  });

  return {
    app,
    chat,
    async start() {
      await app.start();
      log("slack app started (socket mode)");
    },
    async stop() {
      await app.stop();
      log("slack app stopped");
    },
  };
}
