import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { SnapshotHolder } from "../../src/config/holder.js";
import { FakeIds } from "../../src/ports/ids.js";
import type { AgentRunner, TurnOutcome, TurnSpec } from "../../src/ports/runner.js";
import { Scheduler } from "../../src/scheduler/scheduler.js";
import { appendMessage } from "../../src/store/messages.js";
import * as schema from "../../src/store/schema.js";
import { container, world } from "../turn/helpers.js";

const UUIDS = Array.from(
  { length: 20 },
  (_, i) => `3333333${i.toString(16)}-3333-4333-8333-333333333333`,
);

class FakeRunner implements AgentRunner {
  readonly specs: TurnSpec[] = [];
  #envelopes: unknown[];
  constructor(envelopes: unknown[]) {
    this.#envelopes = [...envelopes];
  }
  async run(spec: TurnSpec): Promise<TurnOutcome> {
    this.specs.push(spec);
    const structuredOutput = this.#envelopes.shift();
    return {
      status: "ok",
      sessionId: spec.sessionId,
      resultText: undefined,
      structuredOutput,
      costMicro: 1_000,
      costBasis: "list",
      modelUsage: {},
      cacheRead: 900,
      cacheCreation: 100,
      inputTokens: 1_000,
      permissionDenials: [],
      rateLimit: undefined,
      mcpStatus: {},
      exitCode: 0,
      signal: null,
      error: undefined,
      runFile: "/dev/null",
    };
  }
}

function scheduler(envelopes: unknown[] = [], mayRun: (a: string) => boolean = () => true) {
  const w = world();
  const holder = SnapshotHolder.open(w.home);
  const runner = new FakeRunner(envelopes);
  const s = new Scheduler({
    db: w.db,
    clock: w.clock,
    ids: new FakeIds(UUIDS),
    holder,
    runner,
    runsDir: mkdtempSync(join(tmpdir(), "runs-")),
    hookPath: "/t/hook.mjs",
    mayRun,
    onPermission: async () => ({ behavior: "deny", message: "no" }),
  });
  return { ...w, holder, runner, s };
}

describe("Scheduler", () => {
  it("runs a turn for the addressee and records what it cost", async () => {
    const { db, clock, s, runner } = scheduler([{ messages: [], remember: [], parked: [] }]);
    const c = container(db, {
      kind: "dm",
      name: "dm:ceo",
      members: ["ceo", "owner"],
      defaultTo: "ceo",
    });
    appendMessage(db, clock, {
      containerId: c,
      author: "owner",
      to: "ceo",
      body: "ciao",
      kind: "say",
    });
    s.wakeAgent("ceo", "test");
    await s.loopFor("ceo").settled();

    const turn = db.orm.select().from(schema.turns).all()[0];
    expect(turn?.agent).toBe("ceo");
    expect(turn?.status).toBe("ok");
    expect(turn?.costMicrousd).toBe(1_000);
    expect(runner.specs).toHaveLength(1);
    expect(runner.specs[0]?.prompt).toContain("[#1] owner (say): ciao");
    db.close();
  });

  it("consumes each message exactly once: a second wake with nothing new runs no turn", async () => {
    const { db, clock, s } = scheduler([{ messages: [], remember: [], parked: [] }]);
    const c = container(db, {
      kind: "dm",
      name: "dm:ceo",
      members: ["ceo", "owner"],
      defaultTo: "ceo",
    });
    appendMessage(db, clock, {
      containerId: c,
      author: "owner",
      to: "ceo",
      body: "ciao",
      kind: "say",
    });
    s.wakeAgent("ceo", "first");
    await s.loopFor("ceo").settled();
    s.wakeAgent("ceo", "again");
    await s.loopFor("ceo").settled();
    expect(db.orm.select().from(schema.turns).all()).toHaveLength(1);
    db.close();
  });

  it("delivers the envelope and wakes whoever it addressed", async () => {
    const { db, clock, s } = scheduler([
      {
        messages: [{ container: "agentopolis-hq", to: "ada", kind: "say", body: "pensaci tu" }],
        remember: [],
        parked: [],
      },
      { messages: [], remember: [], parked: [] },
    ]);
    container(db, { kind: "dm", name: "dm:ceo", members: ["ceo", "owner"], defaultTo: "ceo" });
    container(db, {
      kind: "standing",
      name: "agentopolis-hq",
      members: ["ceo", "ada", "owner"],
      defaultTo: "ada",
    });
    const c = db.orm.select().from(schema.containers).all()[0];
    appendMessage(db, clock, {
      containerId: c?.id ?? 1,
      author: "owner",
      to: "ceo",
      body: "parla con ada",
      kind: "say",
    });
    s.wakeAgent("ceo", "test");
    await s.loopFor("ceo").settled();
    await s.loopFor("ada").settled();

    const delivered = db.orm.select().from(schema.messages).all();
    expect(delivered.map((m) => m.to)).toEqual(["ceo", "ada"]);
    // ada was woken by the delivery and ran her own turn
    expect(
      db.orm
        .select()
        .from(schema.turns)
        .all()
        .map((t) => t.agent),
    ).toEqual(["ceo", "ada"]);
    db.close();
  });

  it("a turn whose result carries no structured_output is a failed turn (spec section 13)", async () => {
    const { db, clock, s } = scheduler([undefined]);
    const c = container(db, {
      kind: "dm",
      name: "dm:ceo",
      members: ["ceo", "owner"],
      defaultTo: "ceo",
    });
    appendMessage(db, clock, {
      containerId: c,
      author: "owner",
      to: "ceo",
      body: "ciao",
      kind: "say",
    });
    s.wakeAgent("ceo", "test");
    await s.loopFor("ceo").settled();
    const turn = db.orm.select().from(schema.turns).all()[0];
    expect(turn?.status).toBe("failed");
    expect(turn?.error).toMatch(/structured_output/);
    expect(
      db.orm
        .select()
        .from(schema.events)
        .all()
        .map((e) => e.kind),
    ).toContain("envelope.missing");
    db.close();
  });

  it("a paused agent gets no turn, and the message still waits for it", async () => {
    const paused = new Set(["ceo"]);
    const { db, clock, s } = scheduler(
      [{ messages: [], remember: [], parked: [] }],
      (a) => !paused.has(a),
    );
    const c = container(db, {
      kind: "dm",
      name: "dm:ceo",
      members: ["ceo", "owner"],
      defaultTo: "ceo",
    });
    appendMessage(db, clock, {
      containerId: c,
      author: "owner",
      to: "ceo",
      body: "ciao",
      kind: "say",
    });
    s.wakeAgent("ceo", "while paused");
    await s.loopFor("ceo").settled();
    expect(db.orm.select().from(schema.turns).all()).toHaveLength(0);

    paused.delete("ceo");
    s.wakeAgent("ceo", "resumed");
    await s.loopFor("ceo").settled();
    expect(db.orm.select().from(schema.turns).all()).toHaveLength(1);
    db.close();
  });

  it("marks a turn left running by a crash as interrupted, and tells the agent", () => {
    const { db, clock, s } = scheduler();
    container(db, { kind: "dm", name: "dm:ceo", members: ["ceo", "owner"], defaultTo: "ceo" });
    db.orm
      .insert(schema.turns)
      .values({
        agent: "ceo",
        startedAt: clock.now(),
        status: "running",
        sessionId: UUIDS[0] ?? "s",
        configVersion: "v",
      })
      .run();

    expect(s.markInterruptedTurns()).toHaveLength(1);
    const turn = db.orm.select().from(schema.turns).all()[0];
    expect(turn?.status).toBe("interrupted");
    const note = db.orm
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.kind, "system"))
      .get();
    expect(note?.to).toBe("ceo");
    expect(note?.body).toMatch(/interrotto/);
    db.close();
  });

  it("replays wakes at boot for every agent with something pending", () => {
    const { db, clock, s } = scheduler();
    const c = container(db, {
      kind: "dm",
      name: "dm:ada",
      members: ["ada", "owner"],
      defaultTo: "ada",
    });
    appendMessage(db, clock, {
      containerId: c,
      author: "owner",
      to: "ada",
      body: "rimasto in sospeso",
      kind: "say",
    });
    expect(s.replayWakes()).toEqual(["ada"]);
    db.close();
  });

  it("takes the global cap from config and lets the back-off drop it to one (A8)", () => {
    const { db, s } = scheduler();
    expect(s.concurrency).toBe(2); // the fixture's max_concurrent_turns
    s.setConcurrency(1);
    expect(s.concurrency).toBe(1);
    s.setConcurrency(0);
    expect(s.concurrency).toBe(1); // never below one
    db.close();
  });

  it("never gives the owner a loop: the owner is not an agent", async () => {
    const { db, s } = scheduler();
    s.wakeAgent("owner", "owner typed something");
    await s.stop(100);
    expect(db.orm.select().from(schema.turns).all()).toHaveLength(0);
    db.close();
  });
});
