import { describe, expect, it } from "vitest";
import { FakeClock, SystemClock } from "../../src/ports/clock.js";
import { FakeIds } from "../../src/ports/ids.js";

describe("clock", () => {
  it("system clock returns epoch milliseconds", () => {
    const t = new SystemClock().now();
    expect(Number.isInteger(t)).toBe(true);
    expect(t).toBeGreaterThan(1_700_000_000_000);
  });
  it("fake clock advances only when told", () => {
    const c = new FakeClock(1_000);
    expect(c.now()).toBe(1_000);
    c.advance(500);
    expect(c.now()).toBe(1_500);
  });
  it("fake ids hand out the seeded values in order and then throw", () => {
    const ids = new FakeIds(["a", "b"]);
    expect(ids.uuid()).toBe("a");
    expect(ids.uuid()).toBe("b");
    expect(() => ids.uuid()).toThrow();
  });
});
