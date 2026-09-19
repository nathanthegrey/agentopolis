import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AgentLoop } from "../../src/scheduler/agent-loop.js";

// The scheduler's invariants, over random interleavings of posts and pauses (spec section 14).
// The model is deliberately small: a pending list per agent, a loop per agent, a global cap.

type Op =
  | { op: "post"; agent: string; id: number }
  | { op: "pause"; agent: string }
  | { op: "resume"; agent: string }
  | { op: "settle" };

const AGENTS = ["ada", "jarvis", "nina"];

const ops = fc.array(
  fc.oneof(
    fc.record({
      op: fc.constant("post" as const),
      agent: fc.constantFrom(...AGENTS),
      id: fc.integer({ min: 1, max: 1_000 }),
    }),
    fc.record({ op: fc.constant("pause" as const), agent: fc.constantFrom(...AGENTS) }),
    fc.record({ op: fc.constant("resume" as const), agent: fc.constantFrom(...AGENTS) }),
    fc.constant({ op: "settle" as const }),
  ),
  { minLength: 1, maxLength: 40 },
);

type Run = {
  delivered: Map<string, number[]>;
  concurrent: number;
  maxConcurrent: number;
  perAgentConcurrent: Map<string, number>;
  violations: string[];
};

async function simulate(cap: number, script: Op[]): Promise<Run> {
  const pending = new Map<string, number[]>(AGENTS.map((a) => [a, []]));
  const posted = new Map<string, number[]>(AGENTS.map((a) => [a, []]));
  const paused = new Set<string>();
  const run: Run = {
    delivered: new Map(AGENTS.map((a) => [a, []])),
    concurrent: 0,
    maxConcurrent: 0,
    perAgentConcurrent: new Map(AGENTS.map((a) => [a, 0])),
    violations: [],
  };

  // a hand-rolled cap, so the property does not depend on p-limit's internals
  let active = 0;
  const waiting: (() => void)[] = [];
  const limit = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= cap) await new Promise<void>((r) => waiting.push(r));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };

  const loops = new Map<string, AgentLoop>();
  for (const agent of AGENTS) {
    loops.set(
      agent,
      new AgentLoop(agent, {
        limit,
        mayRun: (a) => !paused.has(a),
        hasWork: (a) => (pending.get(a)?.length ?? 0) > 0,
        runTurn: async (a) => {
          const mine = (run.perAgentConcurrent.get(a) ?? 0) + 1;
          run.perAgentConcurrent.set(a, mine);
          if (mine > 1) run.violations.push(`two turns at once for ${a}`);
          run.concurrent += 1;
          run.maxConcurrent = Math.max(run.maxConcurrent, run.concurrent);

          const take = pending.get(a) ?? [];
          run.delivered.get(a)?.push(...take);
          take.length = 0;
          await new Promise((r) => setTimeout(r, 0));

          run.concurrent -= 1;
          run.perAgentConcurrent.set(a, (run.perAgentConcurrent.get(a) ?? 1) - 1);
        },
      }),
    );
  }

  for (const step of script) {
    if (step.op === "post") {
      pending.get(step.agent)?.push(step.id);
      posted.get(step.agent)?.push(step.id);
      loops.get(step.agent)?.wake("post");
    } else if (step.op === "pause") {
      paused.add(step.agent);
    } else if (step.op === "resume") {
      paused.delete(step.agent);
      loops.get(step.agent)?.wake("resumed");
    } else {
      await Promise.all([...loops.values()].map((l) => l.settled()));
    }
  }
  // everything unpaused at the end, so the run can finish
  paused.clear();
  for (const loop of loops.values()) loop.wake("drain");
  await Promise.all([...loops.values()].map((l) => l.settled()));

  for (const agent of AGENTS) {
    const got = run.delivered.get(agent) ?? [];
    const want = posted.get(agent) ?? [];
    if (got.length !== want.length)
      run.violations.push(`${agent}: ${got.length} of ${want.length}`);
    if (got.join(",") !== want.join(",")) run.violations.push(`${agent}: out of order or lost`);
  }
  return run;
}

describe("scheduler invariants", () => {
  it("never two turns for one agent, every message delivered exactly once, cap respected", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), ops, async (cap, script) => {
        const run = await simulate(cap, script);
        expect(run.violations).toEqual([]);
        expect(run.maxConcurrent).toBeLessThanOrEqual(cap);
      }),
      { numRuns: 60 },
    );
  });

  it("no message is ever delivered before it was posted", async () => {
    await fc.assert(
      fc.asyncProperty(ops, async (script) => {
        const run = await simulate(2, script);
        // delivery order equals post order per agent, which is the property above stated sharply
        expect(run.violations).toEqual([]);
      }),
      { numRuns: 40 },
    );
  });
});
