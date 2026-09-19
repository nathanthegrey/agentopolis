import { describe, expect, it } from "vitest";
import { SnapshotHolder } from "../../src/config/holder.js";
import { Guards } from "../../src/governance/guards.js";
import { appendMessage } from "../../src/store/messages.js";
import * as schema from "../../src/store/schema.js";
import { container, jobAgent, world } from "../turn/helpers.js";

function guards() {
  const w = world();
  const holder = SnapshotHolder.open(w.home);
  const notes: { to: string; body: string }[] = [];
  const g = new Guards({
    db: w.db,
    clock: w.clock,
    holder,
    systemNote: (agent, containerId, body) => {
      notes.push({ to: agent, body });
      appendMessage(w.db, w.clock, {
        containerId,
        author: "daemon",
        to: agent,
        body,
        kind: "system",
      });
    },
  });
  const taskId = w.db.orm
    .insert(schema.tasks)
    .values({
      project: "agentopolis",
      title: "un compito",
      lead: "ada",
      status: "open",
      model: "sonnet",
      effort: "high",
      openedAt: w.clock.now(),
    })
    .returning({ id: schema.tasks.id })
    .get().id;
  const containerId = container(w.db, {
    kind: "task",
    name: `task:${taskId}`,
    members: ["ada", "nina", "owner"],
    defaultTo: "ada",
    taskId,
  });
  jobAgent(w.db, { name: "nina", role: "developer", project: "agentopolis", taskId });
  return { ...w, holder, guards: g, notes, taskId, containerId };
}

const chat = (
  w: ReturnType<typeof guards>,
  n: number,
  author = "nina",
  to = "ada",
  kind: "say" | "report" = "say",
) => {
  for (let i = 0; i < n; i += 1) {
    appendMessage(w.db, w.clock, { containerId: w.containerId, author, to, body: `m${i}`, kind });
  }
};

const rejectReview = (w: ReturnType<typeof guards>, n: number) => {
  for (let i = 0; i < n; i += 1) {
    w.clock.advance(1);
    w.db.orm
      .insert(schema.events)
      .values({ at: w.clock.now(), kind: "review_rejected", payload: { taskId: w.taskId } })
      .run();
  }
};

describe("loop guard (A5)", () => {
  it("does not trip below the configured count", () => {
    const w = guards();
    chat(w, 11);
    expect(w.guards.loopGuard(w.taskId)).toEqual({ tripped: false });
    w.db.close();
  });

  it("trips at loop_guard.messages agent-authored messages", () => {
    const w = guards();
    chat(w, 12);
    expect(w.guards.loopGuard(w.taskId)).toEqual({ tripped: true, why: "messages", count: 12 });
    w.db.close();
  });

  it("never counts the owner or the daemon towards an agent loop", () => {
    const w = guards();
    chat(w, 11);
    chat(w, 5, "daemon", "nina");
    // the owner's own messages reset the counter rather than feeding it
    expect(w.guards.loopGuard(w.taskId).tripped).toBe(false);
    w.db.close();
  });

  it("resets on any owner message in the thread", () => {
    const w = guards();
    chat(w, 12);
    expect(w.guards.loopGuard(w.taskId).tripped).toBe(true);
    chat(w, 1, "owner", "ada");
    expect(w.guards.loopGuard(w.taskId)).toEqual({ tripped: false });
    w.db.close();
  });

  it("trips on rejected reviews too", () => {
    const w = guards();
    rejectReview(w, 3);
    expect(w.guards.loopGuard(w.taskId)).toEqual({
      tripped: true,
      why: "review_rejections",
      count: 3,
    });
    w.db.close();
  });

  it("blocks the task, tells its agents, and gives no further turn until Sblocca", () => {
    const w = guards();
    chat(w, 12);
    const verdict = w.guards.loopGuard(w.taskId);
    expect(verdict.tripped).toBe(true);
    if (!verdict.tripped) return;

    expect(w.guards.blockTask(w.taskId, verdict)).toBe(true);
    expect(w.db.orm.select().from(schema.tasks).all()[0]?.status).toBe("blocked");
    expect(w.notes.map((n) => n.to).sort()).toEqual(["ada", "nina"]);
    expect(w.notes[0]?.body).toMatch(/bloccato/);
    expect(w.guards.taskIsBlocked("nina")).toBe(true);

    // blocking twice changes nothing
    expect(w.guards.blockTask(w.taskId, verdict)).toBe(false);
    w.db.close();
  });

  it("Sblocca reopens the task and starts every counter again", () => {
    const w = guards();
    chat(w, 12);
    const verdict = w.guards.loopGuard(w.taskId);
    if (!verdict.tripped) return;
    w.guards.blockTask(w.taskId, verdict);

    expect(w.guards.unblockTask(w.taskId)).toBe(true);
    expect(w.db.orm.select().from(schema.tasks).all()[0]?.status).toBe("open");
    expect(w.guards.taskIsBlocked("nina")).toBe(false);
    expect(w.guards.loopGuard(w.taskId)).toEqual({ tripped: false });
    // and it counts again from here
    chat(w, 12);
    expect(w.guards.loopGuard(w.taskId).tripped).toBe(true);
    w.db.close();
  });
});

describe("rung counter (D3)", () => {
  it("does not refuse after one red report", () => {
    const w = guards();
    appendMessage(w.db, w.clock, {
      containerId: w.containerId,
      author: "nina",
      to: "ada",
      body: "rotto",
      kind: "report",
      testsGreen: false,
    });
    expect(w.guards.rungRefused("nina")).toBe(false);
    w.db.close();
  });

  it("refuses a third turn after two reports with tests_green false on the same rung", () => {
    const w = guards();
    for (const i of [1, 2]) {
      appendMessage(w.db, w.clock, {
        containerId: w.containerId,
        author: "nina",
        to: "ada",
        body: `rotto ${i}`,
        kind: "report",
        testsGreen: false,
      });
    }
    expect(w.guards.rungRefused("nina")).toBe(true);
    const note = w.notes.at(-1);
    expect(note?.to).toBe("ada");
    expect(note?.body).toMatch(/sonnet\/high/);
    expect(note?.body).toMatch(/un gradino sopra|chiedi al proprietario/);
    w.db.close();
  });

  it("never counts a green report", () => {
    const w = guards();
    for (const green of [true, true]) {
      appendMessage(w.db, w.clock, {
        containerId: w.containerId,
        author: "nina",
        to: "ada",
        body: "ok",
        kind: "report",
        testsGreen: green,
      });
    }
    expect(w.guards.rungRefused("nina")).toBe(false);
    w.db.close();
  });

  it("tells the lead once per rung, not once per turn", () => {
    const w = guards();
    for (const i of [1, 2]) {
      appendMessage(w.db, w.clock, {
        containerId: w.containerId,
        author: "nina",
        to: "ada",
        body: `rotto ${i}`,
        kind: "report",
        testsGreen: false,
      });
    }
    w.guards.rungRefused("nina");
    w.guards.rungRefused("nina");
    expect(w.notes.filter((n) => n.body.includes("gradino"))).toHaveLength(1);
    w.db.close();
  });

  it("a rung change starts the counter again (A2)", () => {
    const w = guards();
    for (const i of [1, 2]) {
      appendMessage(w.db, w.clock, {
        containerId: w.containerId,
        author: "nina",
        to: "ada",
        body: `rotto ${i}`,
        kind: "report",
        testsGreen: false,
      });
    }
    expect(w.guards.rungRefused("nina")).toBe(true);

    w.clock.advance(1_000);
    w.guards.changeRung(w.taskId, "opus", "high");
    expect(w.guards.rungRefused("nina")).toBe(false);
    const task = w.db.orm.select().from(schema.tasks).all()[0];
    expect(task?.model).toBe("opus");
    w.db.close();
  });

  it("refuses on two rejected reviews on the rung as well", () => {
    const w = guards();
    rejectReview(w, 2);
    expect(w.guards.rungRefused("nina")).toBe(true);
    w.db.close();
  });

  it("says nothing about a standing agent, which has no rung", () => {
    const w = guards();
    expect(w.guards.rungRefused("ada")).toBe(false);
    expect(w.guards.taskIsBlocked("ada")).toBe(false);
    w.db.close();
  });
});
