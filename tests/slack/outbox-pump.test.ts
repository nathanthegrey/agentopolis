import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadHome, type Snapshot } from "../../src/config/loader.js";
import { ChatError, type PostArgs } from "../../src/ports/chat.js";
import { FakeClock } from "../../src/ports/clock.js";
import { FakeChat } from "../../src/slack/fake-chat.js";
import { startOutboxPump } from "../../src/slack/outbox-pump.js";
import { resetPersonaLevel } from "../../src/slack/persona.js";
import { openDatabase } from "../../src/store/db.js";
import { appendMessage } from "../../src/store/messages.js";
import { enqueueOutbox } from "../../src/store/outbox.js";
import { containers, events, outbox } from "../../src/store/schema.js";

const home = loadHome(fileURLToPath(new URL("../fixtures/home-valid/", import.meta.url)));
if (!home.ok) throw new Error("fixture");
const snapshot: Snapshot = home.snapshot;
const OWNER = snapshot.config.slack.owner_user_id;

function setup(opts: { snapshot?: Snapshot; chat?: FakeChat } = {}) {
  resetPersonaLevel();
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "pump-")), "a.db"));
  const clock = new FakeClock(1_000_000);
  const chat = opts.chat ?? new FakeChat();
  const snap = opts.snapshot ?? snapshot;
  const pump = startOutboxPump({
    db,
    chat,
    clock,
    snapshotOf: () => snap,
    tickMs: 0,
    log: () => {},
  });
  const container = (slackChannel: string | null, slackThreadTs: string | null = null) =>
    db.orm
      .insert(containers)
      .values({
        kind: "standing",
        members: ["ceo", "owner"],
        defaultTo: "ceo",
        slackChannel,
        slackThreadTs,
      })
      .returning({ id: containers.id })
      .get().id;
  const rows = () => db.orm.select().from(outbox).all();
  const eventKinds = () =>
    db.orm
      .select()
      .from(events)
      .all()
      .map((e) => e.kind);
  const posts = () => chat.calls.filter((c) => c.method === "post").map((c) => c.args as PostArgs);
  return { db, clock, chat, pump, container, rows, eventKinds, posts };
}

describe("outbox pump", () => {
  it("mirrors a message with the agent's persona into the container's thread and records mirror.sent", async () => {
    const t = setup();
    const c = t.container("C1", "1700.5");
    appendMessage(t.db, t.clock, {
      containerId: c,
      author: "ceo",
      to: "owner",
      body: "ciao capo",
      kind: "say",
    });
    expect(await t.pump.tick()).toBe(1);
    const p = t.posts()[0];
    expect(p?.channel).toBe("C1");
    expect(p?.threadTs).toBe("1700.5");
    expect(p?.text).toBe("ciao capo");
    expect(p?.persona?.username).toBe("Ada · CEO");
    expect(t.rows()[0]?.doneAt).toBe(t.clock.now());
    expect(t.rows()[0]?.slackTs).toBe("1700000000.000001");
    expect(t.eventKinds()).toEqual(["message.posted", "mirror.sent"]);
    await t.pump.stop();
  });

  it("mentions the owner only on an ask to the owner, at most once per agent per hour", async () => {
    const t = setup();
    const c = t.container("C1");
    appendMessage(t.db, t.clock, {
      containerId: c,
      author: "ceo",
      to: "owner",
      body: "nota",
      kind: "say",
    });
    await t.pump.tick();
    t.clock.advance(1_000);
    appendMessage(t.db, t.clock, {
      containerId: c,
      author: "ceo",
      to: "owner",
      body: "domanda?",
      kind: "ask",
    });
    await t.pump.tick();
    t.clock.advance(1_000);
    appendMessage(t.db, t.clock, {
      containerId: c,
      author: "ceo",
      to: "owner",
      body: "altra?",
      kind: "ask",
    });
    await t.pump.tick();
    t.clock.advance(3_600_001);
    appendMessage(t.db, t.clock, {
      containerId: c,
      author: "ceo",
      to: "owner",
      body: "dopo un'ora?",
      kind: "ask",
    });
    await t.pump.tick();
    expect(t.posts().map((p) => p.text)).toEqual([
      "nota",
      `<@${OWNER}> domanda?`,
      "altra?",
      `<@${OWNER}> dopo un'ora?`,
    ]);
    await t.pump.stop();
  });

  it("system messages and unknown authors go out as the app identity", async () => {
    const t = setup();
    const c = t.container("C1");
    appendMessage(t.db, t.clock, {
      containerId: c,
      author: "daemon",
      to: "owner",
      body: "Leo è in pausa",
      kind: "system",
    });
    await t.pump.tick();
    expect(t.posts()[0]?.persona).toBeUndefined();
    await t.pump.stop();
  });

  it("sends at most one message per second per channel, without blocking other channels", async () => {
    const t = setup();
    const c1 = t.container("C1");
    const c2 = t.container("C2");
    appendMessage(t.db, t.clock, {
      containerId: c1,
      author: "ceo",
      to: "owner",
      body: "1",
      kind: "say",
    });
    appendMessage(t.db, t.clock, {
      containerId: c1,
      author: "ceo",
      to: "owner",
      body: "2",
      kind: "say",
    });
    appendMessage(t.db, t.clock, {
      containerId: c2,
      author: "ceo",
      to: "owner",
      body: "3",
      kind: "say",
    });
    expect(await t.pump.tick()).toBe(2);
    expect(t.posts().map((p) => p.text)).toEqual(["1", "3"]);
    expect(await t.pump.tick()).toBe(0);
    t.clock.advance(999);
    expect(await t.pump.tick()).toBe(0);
    t.clock.advance(1);
    expect(await t.pump.tick()).toBe(1);
    expect(t.posts().map((p) => p.text)).toEqual(["1", "3", "2"]);
    await t.pump.stop();
  });

  it("a 429 with Retry-After reschedules exactly then; other errors back off and never drop the row", async () => {
    const t = setup();
    const c = t.container("C1");
    appendMessage(t.db, t.clock, {
      containerId: c,
      author: "ceo",
      to: "owner",
      body: "x",
      kind: "say",
    });
    t.chat.failNext("post", new ChatError("ratelimited", "ratelimited", 5_000));
    expect(await t.pump.tick()).toBe(0);
    expect(t.rows()[0]?.attempts).toBe(1);
    expect(t.rows()[0]?.nextAttemptAt).toBe(t.clock.now() + 5_000);
    t.clock.advance(4_999);
    expect(await t.pump.tick()).toBe(0);
    t.clock.advance(1);
    t.chat.failNext("post", new ChatError("fatal_error", "internal_error"));
    expect(await t.pump.tick()).toBe(0);
    expect(t.rows()[0]?.attempts).toBe(2);
    expect(t.rows()[0]?.nextAttemptAt).toBe(t.clock.now() + 5_000); // second attempt: 5 s backoff
    t.clock.advance(5_000);
    expect(await t.pump.tick()).toBe(1);
    expect(t.rows()[0]?.doneAt).not.toBeNull();
    await t.pump.stop();
  });

  it("a permanent error marks the row done with a mirror.failed event", async () => {
    const t = setup();
    const c = t.container("C9");
    appendMessage(t.db, t.clock, {
      containerId: c,
      author: "ceo",
      to: "owner",
      body: "x",
      kind: "say",
    });
    t.chat.failNext("post", new ChatError("channel_not_found", "channel_not_found"));
    await t.pump.tick();
    expect(t.rows()[0]?.doneAt).not.toBeNull();
    expect(t.rows()[0]?.slackTs).toBeNull();
    const failed = t.db.orm
      .select()
      .from(events)
      .all()
      .find((e) => e.kind === "mirror.failed");
    expect(failed?.payload).toMatchObject({ outboxId: 1, error: "channel_not_found" });
    await t.pump.tick();
    expect(t.posts()).toHaveLength(1); // the one failed attempt; never retried
    await t.pump.stop();
  });

  it("holds a row whose container has no channel yet, once, and sends it when the channel appears", async () => {
    const t = setup();
    const c = t.container(null);
    appendMessage(t.db, t.clock, {
      containerId: c,
      author: "ceo",
      to: "owner",
      body: "presto",
      kind: "say",
    });
    expect(await t.pump.tick()).toBe(0);
    t.clock.advance(60_000);
    expect(await t.pump.tick()).toBe(0);
    expect(t.eventKinds().filter((k) => k === "mirror.held")).toHaveLength(1);
    expect(t.rows()[0]?.doneAt).toBeNull();
    t.db.orm.update(containers).set({ slackChannel: "C1" }).run();
    t.clock.advance(60_000);
    expect(await t.pump.tick()).toBe(1);
    expect(t.posts()[0]?.channel).toBe("C1");
    await t.pump.stop();
  });

  it("card.post, card.update and home.publish are app-identity operations", async () => {
    const t = setup();
    const now = t.clock.now();
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "card" } }];
    enqueueOutbox(t.db.orm, t.clock, {
      kind: "card.post",
      channel: "C1",
      payload: { text: "card", blocks },
    });
    await t.pump.tick();
    const ts = t.rows()[0]?.slackTs ?? "";
    expect(ts).toBeTruthy();
    expect(t.posts()[0]?.persona).toBeUndefined();
    expect(t.posts()[0]?.blocks).toEqual(blocks);
    t.clock.advance(1_000);
    enqueueOutbox(t.db.orm, t.clock, {
      kind: "card.update",
      channel: "C1",
      payload: { ts, text: "done", blocks: [] },
    });
    enqueueOutbox(t.db.orm, t.clock, {
      kind: "home.publish",
      channel: `home:${OWNER}`,
      payload: { user: OWNER, view: { type: "home", blocks: [] } },
    });
    expect(await t.pump.tick()).toBe(2);
    expect(t.chat.calls.map((c) => c.method)).toEqual(["post", "update", "publishHome"]);
    expect(t.rows().every((r) => r.doneAt !== null && r.doneAt >= now)).toBe(true);
    await t.pump.stop();
  });

  it("stop() waits for the in-flight tick", async () => {
    class SlowChat extends FakeChat {
      override async post(args: PostArgs) {
        await new Promise((r) => setTimeout(r, 100));
        return super.post(args);
      }
    }
    const t = setup({ chat: new SlowChat() });
    const c = t.container("C1");
    appendMessage(t.db, t.clock, {
      containerId: c,
      author: "ceo",
      to: "owner",
      body: "lento",
      kind: "say",
    });
    const ticking = t.pump.tick();
    await t.pump.stop();
    expect(t.rows()[0]?.doneAt).not.toBeNull();
    await ticking;
  });
});
