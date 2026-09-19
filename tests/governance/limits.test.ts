import { describe, expect, it } from "vitest";
import { SnapshotHolder } from "../../src/config/holder.js";
import { PlanLimits } from "../../src/governance/guards.js";
import type { RateLimitInfo } from "../../src/ports/runner.js";
import * as schema from "../../src/store/schema.js";
import { world } from "../turn/helpers.js";

function limits() {
  const w = world(1_700_000_000_000);
  const holder = SnapshotHolder.open(w.home);
  const concurrency: number[] = [];
  const l = new PlanLimits({
    db: w.db,
    clock: w.clock,
    holder,
    ownerChannel: () => "C-ceo-dm",
    onConcurrencyChange: (n) => concurrency.push(n),
  });
  return { ...w, holder, limits: l, concurrency };
}

const info = (over: Partial<RateLimitInfo> = {}): RateLimitInfo => ({
  status: "allowed",
  resetsAt: undefined,
  windows: {},
  ...over,
});

const outboxKinds = (w: ReturnType<typeof limits>) =>
  w.db.orm
    .select()
    .from(schema.outbox)
    .all()
    .map((o) => o.kind);

describe("back-off before the limit (A8)", () => {
  it("does nothing while the windows are comfortable", () => {
    const w = limits();
    w.limits.onRateLimit(
      info({ windows: { five_hour: { utilization: 0.4, resetsAt: undefined } } }),
    );
    expect(w.limits.backedOff).toBe(false);
    expect(w.concurrency).toEqual([]);
    expect(w.limits.mayRun()).toBe(true);
    w.db.close();
  });

  it("drops to one turn at a time on allowed_warning", () => {
    const w = limits();
    w.limits.onRateLimit(info({ status: "allowed_warning" }));
    expect(w.limits.backedOff).toBe(true);
    expect(w.concurrency).toEqual([1]);
    // still running: a back-off is not a pause
    expect(w.limits.mayRun()).toBe(true);
    w.db.close();
  });

  it("drops to one when any window passes 90%", () => {
    const w = limits();
    w.limits.onRateLimit(
      info({
        windows: {
          week: { utilization: 0.2, resetsAt: undefined },
          five_hour: { utilization: 0.93, resetsAt: undefined },
        },
      }),
    );
    expect(w.concurrency).toEqual([1]);
    w.db.close();
  });

  it("backs off once, not on every event", () => {
    const w = limits();
    for (let i = 0; i < 3; i += 1) w.limits.onRateLimit(info({ status: "allowed_warning" }));
    expect(w.concurrency).toEqual([1]);
    w.db.close();
  });

  it("goes back to the configured cap once the window is comfortable again", () => {
    const w = limits();
    w.limits.onRateLimit(info({ status: "allowed_warning" }));
    w.limits.onRateLimit(
      info({ windows: { five_hour: { utilization: 0.1, resetsAt: undefined } } }),
    );
    expect(w.limits.backedOff).toBe(false);
    expect(w.concurrency).toEqual([1, 2]); // the fixture's max_concurrent_turns
    w.db.close();
  });
});

describe("limit pause (spec section 13)", () => {
  it("stops every turn until resetsAt and posts one notice", () => {
    const w = limits();
    const resetsAt = w.clock.now() + 3_600_000;
    w.limits.onRateLimit(info({ status: "rejected", resetsAt }));
    expect(w.limits.mayRun()).toBe(false);
    expect(w.limits.pausedUntil).toBe(resetsAt);
    expect(outboxKinds(w)).toEqual(["card.post"]);
    const posted = w.db.orm.select().from(schema.outbox).all()[0];
    expect((posted?.payload as { text: string } | undefined)?.text).toMatch(
      /Limite del piano raggiunto/,
    );
    w.db.close();
  });

  it("edits the notice when the reset time changes, never posts a second one", () => {
    const w = limits();
    const first = w.clock.now() + 3_600_000;
    w.limits.onRateLimit(info({ status: "rejected", resetsAt: first }));
    // the pump has sent it
    w.db.orm.update(schema.outbox).set({ slackTs: "111.222", doneAt: w.clock.now() }).run();

    w.limits.onRateLimit(info({ status: "rejected", resetsAt: first + 600_000 }));
    expect(outboxKinds(w)).toEqual(["card.post", "card.update"]);
    expect(w.limits.pausedUntil).toBe(first + 600_000);
    w.db.close();
  });

  it("runs again by itself once resetsAt has passed", () => {
    const w = limits();
    const resetsAt = w.clock.now() + 60_000;
    w.limits.onRateLimit(info({ status: "rejected", resetsAt }));
    expect(w.limits.mayRun()).toBe(false);
    w.clock.advance(60_001);
    expect(w.limits.mayRun()).toBe(true);
    expect(
      w.db.orm
        .select()
        .from(schema.events)
        .all()
        .map((e) => e.kind),
    ).toContain("limit.resume");
    w.db.close();
  });

  it("pauses after two api_retry events running, and not after one", () => {
    const w = limits();
    w.limits.onApiRetry("rate_limit");
    expect(w.limits.mayRun()).toBe(true);
    w.limits.onApiRetry("overloaded");
    expect(w.limits.mayRun()).toBe(false);
    // +15 minutes when the event carries no reset time
    expect(w.limits.pausedUntil).toBe(w.clock.now() + 15 * 60_000);
    w.db.close();
  });

  it("ignores an api_retry that is neither rate_limit nor overloaded", () => {
    const w = limits();
    w.limits.onApiRetry("connection_error");
    w.limits.onApiRetry("connection_error");
    expect(w.limits.mayRun()).toBe(true);
    w.db.close();
  });

  it("restores a pause from the events at boot: nothing lives in memory", () => {
    const w = limits();
    const resetsAt = w.clock.now() + 3_600_000;
    w.limits.onRateLimit(info({ status: "rejected", resetsAt }));

    const fresh = new PlanLimits({
      db: w.db,
      clock: w.clock,
      holder: w.holder,
      ownerChannel: () => "C-ceo-dm",
      onConcurrencyChange: () => {},
    });
    expect(fresh.mayRun()).toBe(false);
    expect(fresh.pausedUntil).toBe(resetsAt);
    w.db.close();
  });

  it("counts the hours the company stood still this month, for the Home tab", () => {
    const w = limits();
    w.limits.onRateLimit(info({ status: "rejected", resetsAt: w.clock.now() + 60_000 }));
    w.clock.advance(60_001);
    expect(w.limits.mayRun()).toBe(true); // resumes and records it
    expect(w.limits.pausedMsThisMonth(w.clock.now())).toBe(60_001);
    w.db.close();
  });
});
