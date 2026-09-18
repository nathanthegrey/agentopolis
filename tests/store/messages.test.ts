import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/ports/clock.js";
import { openDatabase } from "../../src/store/db.js";
import { appendMessage, pendingFor, recordDelivery } from "../../src/store/messages.js";
import { nextOutbox } from "../../src/store/outbox.js";
import { containers, events } from "../../src/store/schema.js";

const fresh = () => openDatabase(join(mkdtempSync(join(tmpdir(), "db-")), "a.db"));
const standingContainer = (db: ReturnType<typeof fresh>) =>
  db.orm
    .insert(containers)
    .values({ kind: "standing", members: ["ceo", "owner"], defaultTo: "ceo", slackChannel: "C1" })
    .returning({ id: containers.id })
    .get();

describe("messages", () => {
  it("appends a message, its event and its outbox row in one transaction", () => {
    const db = fresh();
    const clock = new FakeClock(1_000);
    const c = standingContainer(db);
    const r = appendMessage(db, clock, {
      containerId: c.id,
      author: "owner",
      to: "ceo",
      body: "ciao",
      kind: "say",
    });
    expect(r.messageId).toBe(1);
    expect(
      db.orm
        .select()
        .from(events)
        .all()
        .map((e) => e.kind),
    ).toEqual(["message.posted"]);
    expect(nextOutbox(db, 1_000, 10).map((o) => o.kind)).toEqual(["mirror.message"]);
    db.close();
  });

  it("pending set is everything addressed to me not yet delivered; delivery is unique", () => {
    const db = fresh();
    const clock = new FakeClock(1_000);
    const c = standingContainer(db);
    const a = appendMessage(db, clock, {
      containerId: c.id,
      author: "owner",
      to: "ceo",
      body: "1",
      kind: "say",
    });
    appendMessage(db, clock, {
      containerId: c.id,
      author: "ceo",
      to: "owner",
      body: "2",
      kind: "say",
    });
    const b = appendMessage(db, clock, {
      containerId: c.id,
      author: "owner",
      to: "ceo",
      body: "3",
      kind: "ask",
    });
    expect(pendingFor(db, "ceo").map((m) => m.id)).toEqual([a.messageId, b.messageId]);
    recordDelivery(db, 1, [a.messageId]);
    expect(pendingFor(db, "ceo").map((m) => m.id)).toEqual([b.messageId]);
    expect(() => recordDelivery(db, 2, [a.messageId])).toThrow();
    db.close();
  });

  it("a failed transaction leaves no message and no event behind", () => {
    const db = fresh();
    const clock = new FakeClock(1_000);
    expect(() =>
      appendMessage(db, clock, {
        containerId: 999,
        author: "owner",
        to: "ceo",
        body: "x",
        kind: "say",
      }),
    ).toThrow();
    expect(db.orm.select().from(events).all()).toHaveLength(0);
    db.close();
  });
});
