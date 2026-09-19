import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { SnapshotHolder } from "../../src/config/holder.js";
import { renderPayload } from "../../src/governance/cards.js";
import { PARKED_DENY, PermissionBroker } from "../../src/governance/permissions.js";
import { FakeTimers } from "../../src/ports/timers.js";
import * as schema from "../../src/store/schema.js";
import { jobAgent, world } from "../turn/helpers.js";

const req = (over: Partial<{ toolName: string; input: unknown }> = {}) => ({
  requestId: "r1",
  toolUseId: "tu1",
  toolName: over.toolName ?? "Bash",
  input: over.input ?? { command: "npm test" },
  suggestions: undefined,
});

function broker() {
  const w = world();
  const holder = SnapshotHolder.open(w.home);
  const timers = new FakeTimers();
  const woken: string[] = [];
  const b = new PermissionBroker({
    db: w.db,
    clock: w.clock,
    timers,
    holder,
    channelFor: () => "C-dm",
    wakeAgent: (a) => woken.push(a),
  });
  return { ...w, holder, timers, broker: b, woken };
}

describe("PermissionBroker", () => {
  it("answers at once when a role rule allows the call", async () => {
    const { db, broker: b } = broker();
    // the lead fixture allows Bash(git *) and Read
    const d = await b.onPermission("ada", 1, req({ toolName: "Read", input: {} }));
    expect(d).toEqual({ behavior: "allow" });
    expect(db.orm.select().from(schema.permissionRequests).all()).toHaveLength(0);
    db.close();
  });

  it("answers at once when a role rule denies it, and tells the model not to retry", async () => {
    const { db, holder, broker: b } = broker();
    const role = holder.current.roles.get("lead");
    if (role) (role.permissions.deny as string[]).push("Bash(rm *)");
    const d = await b.onPermission("ada", 1, req({ input: { command: "rm -rf /" } }));
    expect(d.behavior).toBe("deny");
    if (d.behavior === "deny") expect(d.message).toMatch(/Non riprovare/);
    db.close();
  });

  it("holds a call no rule covers, with the card already up, and answers it if the button lands in time", async () => {
    const { db, broker: b } = broker();
    const pending = b.onPermission("ada", 1, req());
    await Promise.resolve();

    // the card is out before anyone waits
    const render = db.orm.select().from(schema.renders).all()[0];
    expect(render?.kind).toBe("permission");
    expect(
      db.orm
        .select()
        .from(schema.outbox)
        .all()
        .map((o) => o.kind),
    ).toEqual(["card.post"]);
    expect(b.heldCount).toBe(1);

    const row = db.orm.select().from(schema.permissionRequests).all()[0];
    const settled = b.settle(row?.id ?? 0, "allowed", "once", "owner");
    expect(settled.landedInTime).toBe(true);
    expect(await pending).toEqual({ behavior: "allow" });
    db.close();
  });

  it("parks it when the hold runs out, with the exact text that ends the turn (A7)", async () => {
    const { db, timers, broker: b } = broker();
    const pending = b.onPermission("ada", 1, req());
    await Promise.resolve();
    timers.advance(5 * 60_000); // permission_hold_minutes
    const d = await pending;
    expect(d).toEqual({ behavior: "deny", message: PARKED_DENY });
    expect(d.behavior === "deny" && d.message).toContain("chiudi ora il turno con la tua busta");
    expect(d.behavior === "deny" && d.message).toContain("sarai risvegliato con la decisione");

    // the row stays pending: the owner can still decide
    const row = db.orm.select().from(schema.permissionRequests).all()[0];
    expect(row?.status).toBe("pending");
    expect(
      db.orm
        .select()
        .from(schema.events)
        .all()
        .map((e) => e.kind),
    ).toContain("permission.parked");
    db.close();
  });

  it("a button that lands after the park decides the row and wakes the agent", async () => {
    const { db, clock, timers, broker: b, woken } = broker();
    db.orm
      .insert(schema.turns)
      .values({
        agent: "ada",
        startedAt: clock.now(),
        status: "ok",
        sessionId: "s",
        configVersion: "v",
      })
      .run();
    const pending = b.onPermission("ada", 1, req());
    await Promise.resolve();
    timers.advance(5 * 60_000);
    await pending;

    const row = db.orm.select().from(schema.permissionRequests).all()[0];
    const settled = b.settle(row?.id ?? 0, "allowed", "once", "owner");
    expect(settled.landedInTime).toBe(false);
    expect(woken).toEqual(["ada"]);
    expect(
      db.orm
        .select()
        .from(schema.permissionRequests)
        .where(eq(schema.permissionRequests.id, row?.id ?? 0))
        .get()?.status,
    ).toBe("allowed");
    db.close();
  });

  it('"Approva per questo compito" lets the same tool pass without a card next time', async () => {
    const { db, broker: b } = broker();
    jobAgent(db, { name: "dev-1", role: "developer", project: "agentopolis", taskId: 7 });
    const first = b.onPermission("dev-1", 1, req());
    await Promise.resolve();
    const row = db.orm.select().from(schema.permissionRequests).all()[0];
    b.settle(row?.id ?? 0, "allowed", "task", "owner");
    await first;

    const second = await b.onPermission("dev-1", 2, req());
    expect(second).toEqual({ behavior: "allow" });
    // no second card, and no second row
    expect(db.orm.select().from(schema.renders).all()).toHaveLength(1);
    expect(db.orm.select().from(schema.permissionRequests).all()).toHaveLength(1);
    db.close();
  });

  it("the card carries the render id and an epoch, never the payload", async () => {
    const { db, broker: b, timers } = broker();
    const pending = b.onPermission("ada", 1, req({ input: { command: "secret --token abc" } }));
    await Promise.resolve();
    const payload = renderPayload(db, 1);
    expect(payload?.subject).toEqual({ kind: "permission", id: 1 });
    expect(JSON.stringify(payload?.card.blocks)).toContain('"1:0"');
    expect(JSON.stringify(payload?.card.blocks)).not.toContain("secret --token");
    timers.advance(5 * 60_000);
    await pending;
    db.close();
  });

  it("expires a parked permission after the configured hours, but never one still held", async () => {
    const { db, clock, timers, broker: b } = broker();
    const pending = b.onPermission("ada", 1, req());
    await Promise.resolve();
    clock.advance(25 * 3_600_000);
    expect(b.expire()).toEqual([]); // still inside its hold

    timers.advance(5 * 60_000);
    await pending;
    expect(b.expire()).toHaveLength(1);
    expect(db.orm.select().from(schema.permissionRequests).all()[0]?.status).toBe("expired");
    db.close();
  });

  it("releases every held turn at shutdown, so nothing hangs", async () => {
    const { db, broker: b } = broker();
    const pending = b.onPermission("ada", 1, req());
    await Promise.resolve();
    b.releaseAll();
    expect(await pending).toEqual({ behavior: "deny", message: PARKED_DENY });
    expect(b.heldCount).toBe(0);
    db.close();
  });
});
