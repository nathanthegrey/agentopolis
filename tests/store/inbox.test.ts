import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/ports/clock.js";
import { openDatabase } from "../../src/store/db.js";
import { recordInbound } from "../../src/store/inbox.js";

describe("inbox", () => {
  it("dedupes on event_id and on logical key within 24 hours", () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), "db-")), "a.db"));
    const clock = new FakeClock(10_000);
    const key = "C1:1.0";
    expect(
      recordInbound(db, clock, { eventId: "Ev1", logicalKey: key, payload: {} }).inserted,
    ).toBe(true);
    expect(
      recordInbound(db, clock, { eventId: "Ev1", logicalKey: key, payload: {} }).inserted,
    ).toBe(false);
    expect(
      recordInbound(db, clock, { eventId: "Ev2", logicalKey: key, payload: {} }).inserted,
    ).toBe(false);
    clock.advance(86_400_001);
    expect(
      recordInbound(db, clock, { eventId: "Ev3", logicalKey: key, payload: {} }).inserted,
    ).toBe(true);
    db.close();
  });
});
