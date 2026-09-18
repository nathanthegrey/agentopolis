import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/ports/clock.js";
import { createSlackApp } from "../../src/slack/app.js";
import type { Inbound } from "../../src/slack/inbox.js";
import { openDatabase } from "../../src/store/db.js";
import { inbox } from "../../src/store/schema.js";

const OWNER = "U0123ABCD";

function setup() {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "app-")), "a.db"));
  const received: { inbound: Inbound; rowsAtDelivery: number }[] = [];
  const s = createSlackApp({
    token: "xoxb-not-a-real-token",
    appToken: "xapp-not-a-real-token",
    db,
    clock: new FakeClock(1_000),
    ownerUserId: OWNER,
    offline: { botId: "B1", botUserId: "UBOT" },
    onInbound: (inbound) => {
      received.push({ inbound, rowsAtDelivery: db.orm.select().from(inbox).all().length });
    },
  });
  const rows = () => db.orm.select().from(inbox).all();
  return { s, db, received, rows };
}

/** Feeds a payload through Bolt exactly as the Socket Mode receiver would. */
async function feed(
  app: ReturnType<typeof createSlackApp>["app"],
  body: Record<string, unknown>,
  rows: () => unknown[],
) {
  let rowsAtAck = -1;
  await app.processEvent({
    body,
    ack: async () => {
      rowsAtAck = rows().length;
    },
    retryNum: 0,
  });
  return { rowsAtAck };
}

describe("Slack app listeners (offline, through Bolt's processEvent)", () => {
  it("a message event is written to the inbox and delivered as owner_message", async () => {
    const t = setup();
    await feed(
      t.s.app,
      {
        type: "event_callback",
        event_id: "Ev1",
        team_id: "T1",
        api_app_id: "A1",
        event: {
          type: "message",
          channel: "C1",
          user: OWNER,
          text: "ciao",
          ts: "1700.1",
          channel_type: "group",
        },
      },
      t.rows,
    );
    expect(t.rows()).toHaveLength(1);
    expect(t.received[0]?.inbound).toMatchObject({ kind: "owner_message", text: "ciao" });
    expect(t.received[0]?.rowsAtDelivery).toBe(1);
    t.db.close();
  });

  it("a button click is written before it is acked, then delivered", async () => {
    const t = setup();
    const r = await feed(
      t.s.app,
      {
        type: "block_actions",
        trigger_id: "T9",
        team: { id: "T1" },
        user: { id: OWNER },
        api_app_id: "A1",
        container: { channel_id: "C1", message_ts: "1700.2" },
        actions: [
          {
            type: "button",
            action_id: "approve",
            value: "3:1",
            block_id: "approval:3",
            action_ts: "1700.3",
          },
        ],
      },
      t.rows,
    );
    expect(r.rowsAtAck).toBe(1);
    expect(t.received[0]?.inbound).toMatchObject({
      kind: "button",
      actionId: "approve",
      renderId: 3,
      epoch: 1,
    });
    t.db.close();
  });

  it("a slash command and a view submission follow the same write-then-ack order", async () => {
    const t = setup();
    const c = await feed(
      t.s.app,
      {
        command: "/pulse",
        text: "",
        channel_id: "C1",
        user_id: OWNER,
        trigger_id: "T10",
        team_id: "T1",
        api_app_id: "A1",
      },
      t.rows,
    );
    expect(c.rowsAtAck).toBe(1);
    expect(t.received[0]?.inbound).toMatchObject({ kind: "command", name: "pulse" });
    const v = await feed(
      t.s.app,
      {
        type: "view_submission",
        trigger_id: "T11",
        team: { id: "T1" },
        user: { id: OWNER },
        api_app_id: "A1",
        view: {
          id: "V1",
          type: "modal",
          callback_id: "reply",
          private_metadata: '{"renderId":5}',
          state: { values: { text: { text: { type: "plain_text_input", value: "rosso" } } } },
        },
      },
      t.rows,
    );
    expect(v.rowsAtAck).toBe(2);
    expect(t.received[1]?.inbound).toMatchObject({
      kind: "view_submitted",
      callbackId: "reply",
      metadata: { renderId: 5 },
      values: { text: "rosso" },
    });
    t.db.close();
  });
});
