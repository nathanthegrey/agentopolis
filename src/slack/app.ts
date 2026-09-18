// One Bolt App (Socket Mode) per configured Slack app, all feeding one inbox.
//
// Ack finding (Bolt 5.1.0, dist/App.js "Events API requests are acknowledged right away"):
// Events API events are acknowledged by Bolt BEFORE the listener chain runs, so for events
// "ack after durable write" is not available; the durable write is the listener's first
// statement and the two dedup keys cover Slack's redeliveries. Actions, view submissions and
// slash commands receive `ack` and are acknowledged only after the inbox row exists.
import { App, LogLevel } from "@slack/bolt";
import { type AppName, COMPANY_APP } from "../ports/chat.js";
import type { Clock } from "../ports/clock.js";
import type { Db } from "../store/db.js";
import { BoltChat, CLIENT_OPTIONS, type SlackClient } from "./bolt-chat.js";
import { handleAction, handleCommand, handleEvent, handleView, type Inbound } from "./inbox.js";

export type AppTokens = { token: string; appToken: string };
export type InboundContext = { inboxId: number; inserted: boolean; via: AppName };
export type SlackAppsOptions = {
  /** app name → tokens; must include "company" */
  apps: Record<AppName, AppTokens>;
  db: Db;
  clock: Clock;
  ownerUserId: string;
  /** returns a value only for view submissions that must be acked with an errors response */
  onInbound: (inbound: Inbound, ctx: InboundContext) => Promise<unknown> | unknown;
  log?: (line: string, extra?: Record<string, unknown>) => void;
  /** tests: skip auth.test and the socket; listeners are driven with app.processEvent */
  offline?: { botId: string; botUserId: string };
};

export type SlackApps = {
  apps: Map<AppName, App>;
  chat: BoltChat;
  start(): Promise<void>;
  stop(): Promise<void>;
};

export function createSlackApps(o: SlackAppsOptions): SlackApps {
  const log = o.log ?? (() => {});
  if (!o.apps[COMPANY_APP]) throw new Error(`slack apps must include "${COMPANY_APP}"`);
  const offline = o.offline;
  const apps = new Map<AppName, App>();
  const clients = new Map<AppName, SlackClient>();

  const deliver = async (
    via: AppName,
    h: { id: number; inserted: boolean; inbound: Inbound },
  ): Promise<unknown> => {
    try {
      return await o.onInbound(h.inbound, { inboxId: h.id, inserted: h.inserted, via });
    } catch (e) {
      log("onInbound failed", { via, inboxId: h.id, error: (e as Error).message });
      return undefined;
    }
  };

  for (const [name, tokens] of Object.entries(o.apps)) {
    const app = new App({
      ...(offline
        ? {
            authorize: async () => ({
              botId: `${offline.botId}_${name}`,
              botUserId: `${offline.botUserId}_${name}`,
              botToken: tokens.token,
            }),
          }
        : { token: tokens.token }),
      appToken: tokens.appToken,
      socketMode: true,
      clientOptions: CLIENT_OPTIONS,
      logLevel: LogLevel.WARN,
      ignoreSelf: true,
    });
    for (const type of [
      "message",
      "reaction_added",
      "app_home_opened",
      "member_joined_channel",
      "channel_archive",
    ]) {
      app.event(type, async ({ body }) => {
        const h = handleEvent(o.db, o.clock, o.ownerUserId, body); // durable first; Bolt already acked
        await deliver(name, h);
      });
    }
    app.action(/.*/, async ({ body, ack }) => {
      const h = handleAction(o.db, o.clock, body); // durable first
      await ack();
      await deliver(name, h);
    });
    app.view(/.*/, async ({ body, ack }) => {
      const h = handleView(o.db, o.clock, body); // durable first
      // a view is acked with its validation result, so dispatch runs between write and ack
      const response = await deliver(name, h);
      const ackWith = ack as unknown as (response?: unknown) => Promise<void>;
      await (response ? ackWith(response) : ack());
    });
    app.command(/\/.*/, async ({ body, ack }) => {
      const h = handleCommand(o.db, o.clock, body); // durable first
      await ack();
      await deliver(name, h);
    });
    apps.set(name, app);
    clients.set(name, app.client as unknown as SlackClient);
  }

  const chat = new BoltChat(clients);
  return {
    apps,
    chat,
    async start() {
      for (const [name, app] of apps) {
        await app.start();
        log("slack app started (socket mode)", { app: name });
      }
    },
    async stop() {
      for (const [name, app] of apps) {
        await app.stop();
        log("slack app stopped", { app: name });
      }
    },
  };
}
