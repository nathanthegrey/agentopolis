import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadHome } from "../../src/config/loader.js";
import { FakeClock } from "../../src/ports/clock.js";
import { ensureChannels } from "../../src/slack/bootstrap.js";
import { FakeChat } from "../../src/slack/fake-chat.js";
import { openDatabase } from "../../src/store/db.js";
import { containers, events } from "../../src/store/schema.js";

const home = loadHome(fileURLToPath(new URL("../fixtures/home-valid/", import.meta.url)));
if (!home.ok) throw new Error("fixture");
const OWNER = home.snapshot.config.slack.owner_user_id;

describe("ensureChannels", () => {
  it("creates #ceo, #<project> and #<project>-work once, invites the owner, writes container rows", async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), "boot-")), "a.db"));
    const chat = new FakeChat();
    const clock = new FakeClock(1_000);
    const first = await ensureChannels(chat, db, clock, home.snapshot, OWNER);
    expect(first.created.map((c) => c.name)).toEqual(["ceo", "agentopolis", "agentopolis-work"]);
    expect(
      chat.calls.filter((c) => c.method === "createPrivateChannel").map((c) => c.args),
    ).toEqual(["ceo", "agentopolis", "agentopolis-work"]);
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
    expect(
      db.orm
        .select()
        .from(events)
        .all()
        .filter((e) => e.kind === "channel.created"),
    ).toHaveLength(3);
    const second = await ensureChannels(chat, db, clock, home.snapshot, OWNER);
    expect(second.created).toEqual([]);
    expect(chat.calls.filter((c) => c.method === "createPrivateChannel")).toHaveLength(3);
    expect(db.orm.select().from(containers).all()).toHaveLength(3);
    db.close();
  });
});
