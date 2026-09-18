import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadHome } from "../../src/config/loader.js";
import { ChatError } from "../../src/ports/chat.js";
import { FakeClock } from "../../src/ports/clock.js";
import { ensureChannels } from "../../src/slack/bootstrap.js";
import { FakeChat } from "../../src/slack/fake-chat.js";
import { openDatabase } from "../../src/store/db.js";
import { containers, events } from "../../src/store/schema.js";

const home = loadHome(fileURLToPath(new URL("../fixtures/home-valid/", import.meta.url)));
if (!home.ok) throw new Error("fixture");
const OWNER = home.snapshot.config.slack.owner_user_id;
const fresh = () => openDatabase(join(mkdtempSync(join(tmpdir(), "boot-")), "a.db"));
const creates = (chat: FakeChat) =>
  chat.calls.filter((c) => c.method === "createPrivateChannel").map((c) => c.args);
const eventKinds = (db: ReturnType<typeof fresh>) =>
  db.orm
    .select()
    .from(events)
    .all()
    .map((e) => e.kind);

describe("ensureChannels", () => {
  it("creates #ceo, #<project> and #<project>-work once, invites the owner, writes container rows", async () => {
    const db = fresh();
    const chat = new FakeChat();
    const clock = new FakeClock(1_000);
    const first = await ensureChannels(chat, db, clock, home.snapshot, OWNER);
    expect(first.created.map((c) => c.name)).toEqual(["ceo", "agentopolis", "agentopolis-work"]);
    expect(first.adopted).toEqual([]);
    expect([...first.channels]).toEqual([
      ["ceo", "C001"],
      ["agentopolis", "C002"],
      ["agentopolis-work", "C003"],
    ]);
    expect(creates(chat)).toEqual(["ceo", "agentopolis", "agentopolis-work"]);
    expect(
      chat.calls
        .filter((c) => c.method === "invite")
        .map((c) => (c.args as { users: string[] }).users),
    ).toEqual([[OWNER], [OWNER], [OWNER]]);
    expect(chat.calls.filter((c) => c.method === "setTopic")).toHaveLength(3);
    const rows = db.orm.select().from(containers).all();
    expect(rows.map((r) => [r.kind, r.defaultTo, r.slackChannel, r.members])).toEqual([
      ["standing", "ceo", "C001", ["ceo", "owner"]],
      ["standing", "agentopolis-lead", "C002", ["agentopolis-lead", "owner"]],
      ["standing", "agentopolis-lead", "C003", ["agentopolis-lead", "owner"]],
    ]);
    expect(eventKinds(db).filter((k) => k === "channel.created")).toHaveLength(3);
    const second = await ensureChannels(chat, db, clock, home.snapshot, OWNER);
    expect(second.created).toEqual([]);
    expect(second.adopted).toEqual([]);
    expect(second.channels.get("ceo")).toBe("C001");
    expect(creates(chat)).toHaveLength(3);
    expect(db.orm.select().from(containers).all()).toHaveLength(3);
    db.close();
  });

  it("with an empty database and the channels already in Slack (reinstall), adopts them all and creates nothing", async () => {
    const db = fresh();
    const chat = new FakeChat({
      preexisting: [
        { id: "CX1", name: "ceo" },
        { id: "CX2", name: "agentopolis" },
        { id: "CX3", name: "agentopolis-work" },
        { id: "CX9", name: "random" },
      ],
    });
    const r = await ensureChannels(chat, db, new FakeClock(1_000), home.snapshot, OWNER);
    expect(r.created).toEqual([]);
    expect(r.adopted.map((a) => a.channel)).toEqual(["CX1", "CX2", "CX3"]);
    expect(creates(chat)).toEqual([]);
    expect(chat.calls.filter((c) => c.method === "listPrivateChannels")).toHaveLength(1);
    expect(
      db.orm
        .select()
        .from(containers)
        .all()
        .map((c) => c.slackChannel),
    ).toEqual(["CX1", "CX2", "CX3"]);
    expect(eventKinds(db).filter((k) => k === "channel.adopted")).toHaveLength(3);
    const again = await ensureChannels(chat, db, new FakeClock(2_000), home.snapshot, OWNER);
    expect(again.adopted).toEqual([]);
    expect(db.orm.select().from(containers).all()).toHaveLength(3);
    db.close();
  });

  it("adopts some, creates the rest, and survives already_in_channel on the invite", async () => {
    const db = fresh();
    const chat = new FakeChat({ preexisting: [{ id: "CX1", name: "ceo" }] });
    chat.failNext("invite", new ChatError("already_in_channel", "already_in_channel"));
    const r = await ensureChannels(chat, db, new FakeClock(1_000), home.snapshot, OWNER);
    expect(r.adopted).toEqual([{ name: "ceo", channel: "CX1" }]);
    expect(r.created.map((c) => c.name)).toEqual(["agentopolis", "agentopolis-work"]);
    expect(r.channels.get("ceo")).toBe("CX1");
    db.close();
  });

  it("name_taken on create never stops the run: the channel is re-listed and adopted", async () => {
    const db = fresh();
    const chat = new FakeChat();
    // the fake's list is empty at first; the channel "appears" right before the create
    const original = chat.listPrivateChannels.bind(chat);
    let listed = 0;
    chat.listPrivateChannels = async () => {
      listed += 1;
      if (listed === 1) return [];
      return [{ id: "CLATE", name: "ceo" }, ...(await original())];
    };
    chat.failNext("createPrivateChannel", new ChatError("name_taken", "name_taken"));
    const r = await ensureChannels(chat, db, new FakeClock(1_000), home.snapshot, OWNER);
    expect(r.adopted).toEqual([{ name: "ceo", channel: "CLATE" }]);
    expect(r.created.map((c) => c.name)).toEqual(["agentopolis", "agentopolis-work"]);
    db.close();
  });
});
