import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/ports/clock.js";
import { createSlackApps, type InboundContext } from "../../src/slack/app.js";
import type { Inbound } from "../../src/slack/inbox.js";
import { openDatabase } from "../../src/store/db.js";
import { inbox } from "../../src/store/schema.js";

const OWNER = "U0123ABCD";

function setup() {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "app-")), "a.db"));
  const received: { inbound: Inbound; ctx: InboundContext; rowsAtDelivery: number }[] = [];
  const s = createSlackApps({
    apps: {
      company: { token: "xoxb-not-a-real-token", appToken: "xapp-not-a-real-token" },
      ada: { token: "xoxb-not-a-real-token-ada", appToken: "xapp-not-a-real-token-ada" },
    },
    db,
    clock: new FakeClock(1_000),
    ownerUserId: OWNER,
    offline: { botId: "B1", botUserId: "UBOT" },
    onInbound: (inbound, ctx) => {
      received.push({ inbound, ctx, rowsAtDelivery: db.orm.select().from(inbox).all().length });
      if (inbound.kind === "view_submitted" && inbound.values.text === "") {
        return { response_action: "errors", errors: { text: "Campo obbligatorio" } };
      }
      return undefined;
    },
  });
  const rows = () => db.orm.select().from(inbox).all();
  return { s, db, received, rows };
}

/** Feeds a payload through one Bolt app exactly as its Socket Mode receiver would. */
async function feed(
  app: ReturnType<typeof createSlackApps>["apps"] extends Map<string, infer A> ? A : never,
  body: Record<string, unknown>,
  rows: () => unknown[],
) {
  let rowsAtAck = -1;
  let ackedWith: unknown = "nothing";
  await app.processEvent({
    body,
    ack: async (response?: unknown) => {
      rowsAtAck = rows().length;
      ackedWith = response;
    },
    retryNum: 0,
  });
  return { rowsAtAck, ackedWith };
}
const appOf = (s: ReturnType<typeof setup>["s"], name: string) => {
  const app = s.apps.get(name);
  if (!app) throw new Error(`no app ${name}`);
  return app;
};

describe("Slack apps (offline, through Bolt's processEvent)", () => {
  it("runs one Bolt app per configured app and needs a company app", () => {
    const t = setup();
    expect([...t.s.apps.keys()]).toEqual(["company", "ada"]);
    expect(t.s.chat.apps).toEqual(["company", "ada"]);
    expect(() =>
      createSlackApps({
        apps: { ada: { token: "x", appToken: "y" } },
        db: t.db,
        clock: new FakeClock(0),
        ownerUserId: OWNER,
        offline: { botId: "B", botUserId: "U" },
        onInbound: () => undefined,
      }),
    ).toThrow(/company/);
    t.db.close();
  });

  it("a DM message received by Ada's app is written to the inbox and delivered with via=ada", async () => {
    const t = setup();
    await feed(
      appOf(t.s, "ada"),
      {
        type: "event_callback",
        event_id: "Ev1",
        team_id: "T1",
        api_app_id: "A2",
        event: {
          type: "message",
          channel: "D1",
          user: OWNER,
          text: "ciao Ada",
          ts: "1700.1",
          channel_type: "im",
        },
      },
      t.rows,
    );
    expect(t.rows()).toHaveLength(1);
    expect(t.received[0]?.inbound).toMatchObject({
      kind: "owner_message",
      text: "ciao Ada",
      channel: "D1",
    });
    expect(t.received[0]?.ctx.via).toBe("ada");
    expect(t.received[0]?.rowsAtDelivery).toBe(1);
    t.db.close();
  });

  it("a button click on the company app is written before it is acked, then delivered with via=company", async () => {
    const t = setup();
    const r = await feed(
      appOf(t.s, "company"),
      {
        type: "block_actions",
        trigger_id: "T9",
        team: { id: "T1" },
        user: { id: OWNER },
        api_app_id: "A1",
        container: { channel_id: "D0", message_ts: "1700.2" },
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
    expect(t.received[0]?.ctx.via).toBe("company");
    t.db.close();
  });

  it("a slash command and a view submission follow the same write-then-ack order; errors travel in the ack", async () => {
    const t = setup();
    const c = await feed(
      appOf(t.s, "company"),
      {
        command: "/diag",
        text: "ada",
        channel_id: "D0",
        user_id: OWNER,
        trigger_id: "T10",
        team_id: "T1",
        api_app_id: "A1",
      },
      t.rows,
    );
    expect(c.rowsAtAck).toBe(1);
    expect(t.received[0]?.inbound).toMatchObject({ kind: "command", name: "diag", text: "ada" });
    const v = await feed(
      appOf(t.s, "company"),
      {
        type: "view_submission",
        trigger_id: "T12",
        team: { id: "T1" },
        user: { id: OWNER },
        api_app_id: "A1",
        view: {
          id: "V2",
          type: "modal",
          callback_id: "reply",
          private_metadata: "{}",
          state: { values: { text: { text: { type: "plain_text_input", value: "" } } } },
        },
      },
      t.rows,
    );
    expect(v.rowsAtAck).toBe(2);
    expect(v.ackedWith).toEqual({
      response_action: "errors",
      errors: { text: "Campo obbligatorio" },
    });
    t.db.close();
  });
});
