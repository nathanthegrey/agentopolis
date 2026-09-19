import { describe, expect, it } from "vitest";
import { AgentLoop, type LoopDeps } from "../../src/scheduler/agent-loop.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

type Recorded = { turns: number; read: number[][] };

function loopOver(pending: number[], over: Partial<LoopDeps> = {}) {
  const recorded: Recorded = { turns: 0, read: [] };
  const deps: LoopDeps = {
    limit: (fn) => fn(),
    mayRun: () => true,
    hasWork: () => pending.length > 0,
    runTurn: async () => {
      recorded.turns += 1;
      recorded.read.push([...pending]);
      pending.length = 0;
    },
    ...over,
  };
  return { loop: new AgentLoop("ceo", deps), recorded };
}

describe("AgentLoop", () => {
  it("a post wakes the addressee, and runs exactly one turn", async () => {
    const pending = [1];
    const { loop, recorded } = loopOver(pending);
    loop.wake("message 1");
    await loop.settled();
    expect(recorded.turns).toBe(1);
    expect(recorded.read).toEqual([[1]]);
  });

  it("does not run at all when there is nothing pending", async () => {
    const { loop, recorded } = loopOver([]);
    loop.wake("nothing");
    await loop.settled();
    expect(recorded.turns).toBe(0);
  });

  it("two posts during a turn produce exactly one more turn, which reads both", async () => {
    const pending = [1];
    const gate = deferred();
    const recorded: Recorded = { turns: 0, read: [] };
    const loop = new AgentLoop("ceo", {
      limit: (fn) => fn(),
      mayRun: () => true,
      hasWork: () => pending.length > 0,
      runTurn: async () => {
        recorded.turns += 1;
        recorded.read.push([...pending]);
        pending.length = 0;
        if (recorded.turns === 1) await gate.promise;
      },
    });
    loop.wake("message 1");
    await Promise.resolve();
    // while the first turn is held open, two more messages land
    pending.push(2, 3);
    loop.wake("message 2");
    loop.wake("message 3");
    gate.resolve();
    await loop.settled();
    expect(recorded.turns).toBe(2);
    expect(recorded.read).toEqual([[1], [2, 3]]);
  });

  it("never runs two turns at once for one agent", async () => {
    const pending = [1];
    let inFlight = 0;
    let maxInFlight = 0;
    const loop = new AgentLoop("ceo", {
      limit: (fn) => fn(),
      mayRun: () => true,
      hasWork: () => pending.length > 0,
      runTurn: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        pending.length = 0;
        inFlight -= 1;
      },
    });
    for (let i = 0; i < 10; i += 1) {
      pending.push(i);
      loop.wake(`m${i}`);
    }
    await loop.settled();
    expect(maxInFlight).toBe(1);
  });

  it("a paused agent is never run, and runs once it may again", async () => {
    const pending = [1];
    let paused = true;
    const { loop, recorded } = loopOver(pending, { mayRun: () => !paused });
    loop.wake("while paused");
    await loop.settled();
    expect(recorded.turns).toBe(0);

    paused = false;
    loop.wake("resumed");
    await loop.settled();
    expect(recorded.turns).toBe(1);
    expect(recorded.read).toEqual([[1]]);
  });

  it("checks again inside the cap: a pause that lands during the wait still holds", async () => {
    const pending = [1];
    let paused = false;
    const release = deferred();
    const { loop, recorded } = loopOver(pending, {
      mayRun: () => !paused,
      limit: async (fn) => {
        await release.promise;
        return fn();
      },
    });
    loop.wake("queued");
    await Promise.resolve();
    paused = true; // the owner pauses while the turn waits for a free slot
    release.resolve();
    await loop.settled();
    expect(recorded.turns).toBe(0);
  });

  it("a failed turn does not wedge the loop, and is reported", async () => {
    const pending = [1];
    const errors: unknown[] = [];
    let first = true;
    const loop = new AgentLoop("ceo", {
      limit: (fn) => fn(),
      mayRun: () => true,
      hasWork: () => pending.length > 0,
      runTurn: async () => {
        if (first) {
          first = false;
          throw new Error("boom");
        }
        pending.length = 0;
      },
      onError: (_agent, e) => errors.push(e),
    });
    loop.wake("one");
    await loop.settled();
    expect(errors).toHaveLength(1);

    loop.wake("two");
    await loop.settled();
    expect(pending).toEqual([]);
  });

  it("stop() refuses further wakes", async () => {
    const pending = [1];
    const { loop, recorded } = loopOver(pending);
    loop.stop();
    loop.wake("too late");
    await loop.settled();
    expect(recorded.turns).toBe(0);
  });
});
