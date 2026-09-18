import { describe, expect, it } from "vitest";
import { budgetKeyFor, MethodBudget, STATUS_LINE_EDIT_MS } from "../../src/slack/limits.js";
import { StatusLineThrottle } from "../../src/slack/status-line.js";

describe("status line throttle", () => {
  it("allows one edit per line every 30 s; lines are independent", () => {
    let now = 5_000;
    const th = new StatusLineThrottle(() => now);
    expect(STATUS_LINE_EDIT_MS).toBe(30_000);
    expect(th.allow("C1:1.1")).toBe(true);
    expect(th.allow("C1:1.1")).toBe(false);
    now += 29_999;
    expect(th.allow("C1:1.1")).toBe(false);
    expect(th.allow("C1:2.2")).toBe(true);
    now += 1;
    expect(th.allow("C1:1.1")).toBe(true);
    th.forget("C1:1.1");
    expect(th.allow("C1:1.1")).toBe(true);
  });
});

describe("MethodBudget", () => {
  it("maps methods to their budget key and slides a one-minute window", () => {
    expect(budgetKeyFor("chat.update")).toBe("chat.update");
    expect(budgetKeyFor("conversations.create")).toBe("conversations.*");
    expect(budgetKeyFor("chat.appendStream")).toBe("chat.appendStream");
    expect(budgetKeyFor("chat.postMessage")).toBeUndefined();
    let now = 0;
    const b = new MethodBudget(() => now);
    for (let i = 0; i < 40; i += 1) {
      expect(b.take("conversations.list")).toEqual({ ok: true });
      now += 1_000; // one call per second: the window starts sliding after 60 s
    }
    // 40 calls inside the last 60 s: the 41st is refused until the oldest (t=0) leaves the window
    expect(b.take("conversations.invite")).toEqual({ ok: false, retryAfterMs: 20_000 });
    now = 60_000;
    expect(b.take("conversations.invite")).toEqual({ ok: true });
    expect(b.take("chat.postMessage")).toEqual({ ok: true }); // unbudgeted
  });
});
