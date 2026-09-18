import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadHome } from "../../src/config/loader.js";
import { ChatError } from "../../src/ports/chat.js";
import { FakeClock } from "../../src/ports/clock.js";
import { ensureContainers, projectChannels } from "../../src/slack/bootstrap.js";
import { FakeChat } from "../../src/slack/fake-chat.js";
import { openDatabase } from "../../src/store/db.js";
import { containers, events } from "../../src/store/schema.js";

const home = loadHome(fileURLToPath(new URL("../fixtures/home-valid/", import.meta.url)));
if (!home.ok) throw new Error("fixture");
const OWNER = home.snapshot.config.slack.owner_user_id;
const fresh = () => openDatabase(join(mkdtempSync(join(tmpdir(), "boot-")), "a.db"));
const calls = (chat: FakeChat, method: string) =>
  chat.calls.filter((c) => c.method === method).map((c) => c.args);
const eventKinds = (db: ReturnType<typeof fresh>) =>
  db.orm
    .select()
    .from(events)
    .all()
    .map((e) => e.kind);

describe("projectChannels", () => {
  it("names #<slug>-hq and #<slug>-work, never the bare slug, with the lead and its app", () => {
    expect(projectChannels(home.snapshot).map((c) => [c.name, c.lead, c.leadApp])).toEqual([
      ["agentopolis-hq", "ada", "ada"],
      ["agentopolis-work", "ada", "ada"],
    ]);
  });
});

describe("ensureContainers", () => {
  it("opens the ceo DM (company) and the lead DM (her app), creates -hq and -work via the company app with the lead's bot invited, records names", async () => {
    const db = fresh();
    const chat = new FakeChat();
    const r = await ensureContainers(chat, db, new FakeClock(1_000), home.snapshot, OWNER);
    expect([...r.dms]).toEqual([
      ["ceo", "D001"],
      ["ada", "D002"],
    ]);
    expect(calls(chat, "openDm")).toEqual([
      { userId: OWNER, as: "company" },
      { userId: OWNER, as: "ada" },
    ]);
    expect(r.created.map((c) => c.name)).toEqual(["agentopolis-hq", "agentopolis-work"]);
    expect(r.adopted).toEqual([]);
    expect([...r.channels]).toEqual([
      ["agentopolis-hq", "C001"],
      ["agentopolis-work", "C002"],
    ]);
    expect(calls(chat, "createPrivateChannel")).toEqual([
      { name: "agentopolis-hq", as: "company" },
      { name: "agentopolis-work", as: "company" },
    ]);
    expect(calls(chat, "invite")).toEqual([
      { channel: "C001", users: [OWNER, "UB_ADA"], as: "company" },
      { channel: "C002", users: [OWNER, "UB_ADA"], as: "company" },
    ]);
    expect(calls(chat, "setTopic")).toHaveLength(2);
    const rows = db.orm.select().from(containers).all();
    expect(rows.map((c) => [c.kind, c.name, c.defaultTo, c.slackChannel, c.members])).toEqual([
      ["dm", "dm:ceo", "ceo", "D001", ["ceo", "owner"]],
      ["dm", "dm:ada", "ada", "D002", ["ada", "owner"]],
      ["standing", "agentopolis-hq", "ada", "C001", ["ada", "owner"]],
      ["standing", "agentopolis-work", "ada", "C002", ["ada", "owner"]],
    ]);
    expect(eventKinds(db)).toEqual([
      "dm.opened",
      "dm.opened",
      "channel.created",
      "channel.created",
    ]);
    const again = await ensureContainers(chat, db, new FakeClock(2_000), home.snapshot, OWNER);
    expect(again.created).toEqual([]);
    expect(again.adopted).toEqual([]);
    expect(again.dms.get("ada")).toBe("D002");
    expect(calls(chat, "openDm")).toHaveLength(2);
    expect(calls(chat, "createPrivateChannel")).toHaveLength(2);
    expect(db.orm.select().from(containers).all()).toHaveLength(4);
    db.close();
  });

  it("with an empty database and the channels already in Slack (reinstall), adopts them and creates nothing", async () => {
    const db = fresh();
    const chat = new FakeChat({
      preexisting: [
        { id: "CX1", name: "agentopolis-hq" },
        { id: "CX2", name: "agentopolis-work" },
        { id: "CX9", name: "ceo" },
      ],
    });
    chat.failNext("invite", new ChatError("already_in_channel", "already_in_channel"));
    const r = await ensureContainers(chat, db, new FakeClock(1_000), home.snapshot, OWNER);
    expect(r.created).toEqual([]);
    expect(r.adopted.map((a) => [a.name, a.channel])).toEqual([
      ["agentopolis-hq", "CX1"],
      ["agentopolis-work", "CX2"],
    ]);
    expect(calls(chat, "createPrivateChannel")).toEqual([]);
    expect(calls(chat, "listPrivateChannels")).toEqual([{ as: "company" }]);
    expect(
      db.orm
        .select()
        .from(containers)
        .all()
        .filter((c) => c.kind === "standing")
        .map((c) => c.name),
    ).toEqual(["agentopolis-hq", "agentopolis-work"]);
    expect(eventKinds(db).filter((k) => k === "channel.adopted")).toHaveLength(2);
    db.close();
  });

  it("name_taken on create never stops the run: the channel is re-listed and adopted", async () => {
    const db = fresh();
    const chat = new FakeChat();
    const original = chat.listPrivateChannels.bind(chat);
    let listed = 0;
    chat.listPrivateChannels = async (as) => {
      listed += 1;
      if (listed === 1) return [];
      return [{ id: "CLATE", name: "agentopolis-hq" }, ...(await original(as))];
    };
    chat.failNext("createPrivateChannel", new ChatError("name_taken", "name_taken"));
    const r = await ensureContainers(chat, db, new FakeClock(1_000), home.snapshot, OWNER);
    expect(r.adopted).toEqual([{ name: "agentopolis-hq", channel: "CLATE" }]);
    expect(r.created.map((c) => c.name)).toEqual(["agentopolis-work"]);
    db.close();
  });
});
