import { describe, expect, it } from "vitest";
import { SnapshotHolder } from "../../src/config/holder.js";
import { Approvals } from "../../src/governance/approvals.js";
import { renderPayload } from "../../src/governance/cards.js";
import * as schema from "../../src/store/schema.js";
import { world } from "../turn/helpers.js";

function approvals() {
  const w = world();
  const holder = SnapshotHolder.open(w.home);
  const woken: string[] = [];
  const opened: { requestId: number; kind: string }[] = [];
  const a = new Approvals({
    db: w.db,
    clock: w.clock,
    holder,
    channelFor: () => "C-hq",
    wakeAgent: (who) => woken.push(who),
    onApproved: (requestId, kind) => opened.push({ requestId, kind }),
  });
  return { ...w, holder, approvals: a, woken, opened };
}

describe("Approvals.request", () => {
  it("refuses a kind the daemon does not know", () => {
    const { db, approvals: a } = approvals();
    const r = a.request("ada", "set_budget", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/set_budget/);
    db.close();
  });

  it("refuses a kind the role does not list, and says which role", () => {
    const { db, approvals: a } = approvals();
    // the ceo fixture lists no requests at all
    const r = a.request("ceo", "open_task", { kind: "develop", preset: "normale" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/ceo/);
    db.close();
  });

  it("approves an ungated open_task at once and hands the intent on", () => {
    const { db, approvals: a, opened } = approvals();
    const r = a.request("ada", "open_task", {
      title: "cambia il footer",
      kind: "develop",
      preset: "normale",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("approved");
    const row = db.orm.select().from(schema.requests).all()[0];
    expect(row?.status).toBe("approved");
    expect(row?.payload as { model: string; effort: string }).toMatchObject({
      model: "sonnet",
      effort: "high",
    });
    expect(opened).toEqual([{ requestId: 1, kind: "open_task" }]);
    expect(db.orm.select().from(schema.renders).all()).toHaveLength(0); // no card needed
    db.close();
  });

  it("resolves each preset to its rung (A1)", () => {
    const { db, approvals: a } = approvals();
    for (const [preset, want] of [
      ["piccolo", { model: "sonnet", effort: "medium" }],
      ["difficile", { model: "opus", effort: "high" }],
    ] as const) {
      a.request("ada", "open_task", { title: preset, kind: "develop", preset });
      const rows = db.orm.select().from(schema.requests).all();
      const last = rows[rows.length - 1];
      expect(last?.payload).toMatchObject(want);
    }
    db.close();
  });

  it("refuses a value outside the job role's menu", () => {
    const { db, approvals: a } = approvals();
    const r = a.request("ada", "open_task", {
      title: "t",
      kind: "develop",
      model: "haiku",
      effort: "high",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/haiku/);
    db.close();
  });

  it("renders a card with the reason for a gated model, and does not approve it (A3)", () => {
    const { db, approvals: a } = approvals();
    const r = a.request("ada", "open_task", {
      title: "riscrivi il parser",
      kind: "develop",
      model: "fable",
      effort: "high",
      reason: "due tentativi falliti su Opus",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("pending");
    expect(r.message).toMatch(/in attesa del proprietario/);
    const payload = renderPayload(db, 1);
    expect(payload?.card.text).toContain("fable");
    expect(payload?.card.text).toContain("riscrivi il parser");
    expect(JSON.stringify(payload?.card.blocks)).toContain("due tentativi falliti su Opus");
    db.close();
  });

  it("always renders a card for merge_production, whatever the payload says", () => {
    const { db, approvals: a } = approvals();
    const r = a.request("ada", "merge_production", { branch: "master" });
    expect(r.ok && r.status).toBe("pending");
    expect(db.orm.select().from(schema.renders).all()).toHaveLength(1);
    db.close();
  });

  it("a decision wakes the agent and hands an approval on", () => {
    const { db, approvals: a, woken, opened } = approvals();
    a.request("ada", "merge_production", { branch: "master" });
    expect(a.decide(1, "approved", "owner")).toBe(true);
    const row = db.orm.select().from(schema.requests).all()[0];
    expect(row?.status).toBe("approved");
    expect(row?.decidedBy).toBe("owner");
    expect(woken).toEqual(["ada"]);
    expect(opened).toEqual([{ requestId: 1, kind: "merge_production" }]);
    // a second click decides nothing
    expect(a.decide(1, "denied", "owner")).toBe(false);
    db.close();
  });

  it("expires a stale request after the configured hours; merge_production never expires", () => {
    const { db, clock, approvals: a } = approvals();
    a.request("ada", "open_task", {
      title: "t",
      kind: "develop",
      model: "fable",
      effort: "high",
      reason: "r",
    });
    a.request("ada", "merge_production", { branch: "master" });
    clock.advance(25 * 3_600_000);
    expect(a.expire()).toEqual([1]);
    const rows = db.orm.select().from(schema.requests).all();
    expect(rows[0]?.status).toBe("expired");
    expect(rows[1]?.status).toBe("pending");
    db.close();
  });

  it("Riapri puts an expired request back with a new epoch, so the old buttons are stale", () => {
    const { db, clock, approvals: a } = approvals();
    a.request("ada", "open_task", {
      title: "t",
      kind: "develop",
      model: "fable",
      effort: "high",
      reason: "r",
    });
    clock.advance(25 * 3_600_000);
    a.expire();
    expect(a.epochIsCurrent(1, 0)).toBe(true);
    expect(a.reopen(1)).toBe(true);

    const row = db.orm.select().from(schema.requests).all()[0];
    expect(row?.status).toBe("pending");
    expect(row?.epoch).toBe(1);
    // the new card carries epoch 1; a click on the old card's epoch 0 is stale
    expect(a.epochIsCurrent(2, 1)).toBe(true);
    expect(a.epochIsCurrent(2, 0)).toBe(false);
    db.close();
  });

  it("rewriting a card keeps the question and drops the buttons", () => {
    const { db, approvals: a } = approvals();
    a.request("ada", "merge_production", { branch: "master" });
    a.decide(1, "approved", "owner");
    a.rewrite(1, "approvato", "owner");
    const payload = renderPayload(db, 1);
    const types = (payload?.card.blocks ?? []).map((b) => (b as { type: string }).type);
    expect(types).not.toContain("actions");
    expect(payload?.card.text).toContain("master");
    expect(
      db.orm
        .select()
        .from(schema.events)
        .all()
        .map((e) => e.kind),
    ).toContain("card.decided");
    db.close();
  });
});
