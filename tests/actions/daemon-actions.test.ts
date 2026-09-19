import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DaemonActionsImpl } from "../../src/actions/daemon-actions.js";
import { SnapshotHolder } from "../../src/config/holder.js";
import { Approvals } from "../../src/governance/approvals.js";
import { renderAskCard } from "../../src/governance/cards.js";
import { Guards, PlanLimits } from "../../src/governance/guards.js";
import { PermissionBroker } from "../../src/governance/permissions.js";
import { FakeIds } from "../../src/ports/ids.js";
import { FakeTimers } from "../../src/ports/timers.js";
import { appendMessage } from "../../src/store/messages.js";
import * as schema from "../../src/store/schema.js";
import { container, world } from "../turn/helpers.js";

function daemon() {
  const w = world();
  const holder = SnapshotHolder.open(w.home);
  const woken: string[] = [];
  const timers = new FakeTimers();
  const containerId = container(w.db, {
    kind: "dm",
    name: "dm:ceo",
    members: ["ceo", "owner"],
    defaultTo: "ceo",
  });
  container(w.db, { kind: "dm", name: "dm:ada", members: ["ada", "owner"], defaultTo: "ada" });

  const common = { db: w.db, clock: w.clock, holder };
  const approvals = new Approvals({
    ...common,
    channelFor: () => "C-hq",
    wakeAgent: (a) => woken.push(a),
  });
  const permissions = new PermissionBroker({
    ...common,
    timers,
    channelFor: () => "C-hq",
    wakeAgent: (a) => woken.push(a),
  });
  const guards = new Guards({ ...common, systemNote: () => {} });
  const limits = new PlanLimits({
    ...common,
    ownerChannel: () => "C-dm",
    onConcurrencyChange: () => {},
  });
  const d = new DaemonActionsImpl({
    ...common,
    ids: new FakeIds(["55555555-5555-4555-8555-555555555555"]),
    approvals,
    permissions,
    guards,
    limits,
    wakeAgent: (a) => woken.push(a),
    containerFor: (agent) => {
      const row = w.db.orm
        .select()
        .from(schema.containers)
        .all()
        .find((c) => c.kind === "dm" && c.members.includes(agent));
      return row ? { id: row.id, slackChannel: row.slackChannel ?? "" } : undefined;
    },
    reload: () => holder.reload(),
  });
  return { ...w, holder, daemon: d, approvals, permissions, timers, woken, containerId };
}

describe("pause and resume", () => {
  it("pauses an agent, notes it, and resumes it with a wake", async () => {
    const w = daemon();
    expect(await w.daemon.pause("ceo")).toEqual({ ok: true });
    expect(w.daemon.isPaused("ceo")).toBe(true);
    const note = w.db.orm.select().from(schema.messages).all()[0];
    expect(note?.kind).toBe("system");
    expect(note?.body).toMatch(/pausa/);

    expect(await w.daemon.resume("ceo")).toEqual({ ok: true });
    expect(w.daemon.isPaused("ceo")).toBe(false);
    expect(w.woken).toEqual(["ceo"]);
    w.db.close();
  });

  it("refuses an agent it does not know", async () => {
    const w = daemon();
    expect(await w.daemon.pause("ghost")).toEqual({ ok: false, reason: "non conosco ghost" });
    w.db.close();
  });
});

describe("restart and setModel", () => {
  it("restart starts a fresh session and keeps MEMORY.md", async () => {
    const w = daemon();
    writeFileSync(join(w.home, "agents", "ceo", "MEMORY.md"), "- ricorda questo\n");
    w.db.orm
      .insert(schema.agents)
      .values({ name: "ceo", role: "ceo", display: "Jarvis", sessionId: "old-session" })
      .run();

    expect(await w.daemon.restart("ceo")).toEqual({ ok: true });
    const row = w.db.orm.select().from(schema.agents).where(eq(schema.agents.name, "ceo")).get();
    expect(row?.sessionId).toBeNull();
    expect(readFileSync(join(w.home, "agents", "ceo", "MEMORY.md"), "utf8")).toContain(
      "ricorda questo",
    );
    w.db.close();
  });

  it("setModel writes the file and starts a session, because a mid-session switch loses the cache", async () => {
    const w = daemon();
    w.db.orm
      .insert(schema.agents)
      .values({ name: "ada", role: "lead", display: "Ada", sessionId: "old" })
      .run();
    expect(await w.daemon.setModel("ada", "opus")).toEqual({ ok: true });
    const row = w.db.orm.select().from(schema.agents).where(eq(schema.agents.name, "ada")).get();
    expect(row?.sessionId).toBeNull();
    expect(readFileSync(join(w.home, "agents", "ada", "agent.yaml"), "utf8")).toContain(
      "model: opus",
    );
    w.db.close();
  });
});

describe("edit and undo", () => {
  it("writes MEMORY.md, keeps the previous content in the event, and puts it back", async () => {
    const w = daemon();
    const path = join(w.home, "agents", "ceo", "MEMORY.md");
    writeFileSync(path, "prima\n");
    expect(await w.daemon.edit("ceo", "MEMORY.md", "dopo\n")).toEqual({ ok: true });
    expect(readFileSync(path, "utf8")).toBe("dopo\n");

    const event = w.db.orm
      .select()
      .from(schema.events)
      .all()
      .find((e) => e.kind === "file.edited");
    expect((event?.payload as { previous: string } | undefined)?.previous).toBe("prima\n");

    expect(await w.daemon.undoEdit("ceo")).toEqual({ ok: true });
    expect(readFileSync(path, "utf8")).toBe("prima\n");
    w.db.close();
  });

  it("says where the role's prose lives rather than guessing which file AGENT.md is", async () => {
    const w = daemon();
    const r = await w.daemon.edit("ceo", "AGENT.md", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/SOUL\.md/);
    w.db.close();
  });

  it("has nothing to undo when nothing was edited", async () => {
    const w = daemon();
    expect((await w.daemon.undoEdit("ceo")).ok).toBe(false);
    w.db.close();
  });
});

describe("answering an ask", () => {
  it("routes the owner's choice to the message that asked, and marks it answered", async () => {
    const w = daemon();
    const ask = appendMessage(w.db, w.clock, {
      containerId: w.containerId,
      author: "ceo",
      to: "owner",
      body: "Apro il compito?",
      kind: "ask",
    });
    const renderId = renderAskCard(w.db, w.clock, {
      messageId: ask.messageId,
      agent: "ceo",
      persona: "Jarvis",
      project: undefined,
      channel: "C-dm",
      question: "Apro il compito?",
      options: ["Sì", "No"],
    });

    expect(await w.daemon.answer(renderId, 0, "U1")).toEqual({ ok: true });
    const messages = w.db.orm.select().from(schema.messages).all();
    const reply = messages.at(-1);
    expect(reply?.author).toBe("owner");
    expect(reply?.to).toBe("ceo");
    expect(reply?.body).toBe("Sì");
    expect(messages[0]?.answeredBy).toBe(reply?.id);
    expect(w.woken).toContain("ceo");
    w.db.close();
  });

  it("free text through the Rispondi modal reaches the same asker", async () => {
    const w = daemon();
    const ask = appendMessage(w.db, w.clock, {
      containerId: w.containerId,
      author: "ceo",
      to: "owner",
      body: "Cosa faccio?",
      kind: "ask",
    });
    const renderId = renderAskCard(w.db, w.clock, {
      messageId: ask.messageId,
      agent: "ceo",
      persona: "Jarvis",
      project: undefined,
      channel: "C-dm",
      question: "Cosa faccio?",
      options: [],
    });
    expect(await w.daemon.reply(renderId, "aspetta domani", "U1")).toEqual({ ok: true });
    expect(w.db.orm.select().from(schema.messages).all().at(-1)?.body).toBe("aspetta domani");
    w.db.close();
  });

  it("refuses an option that is not on the card", async () => {
    const w = daemon();
    const ask = appendMessage(w.db, w.clock, {
      containerId: w.containerId,
      author: "ceo",
      to: "owner",
      body: "q",
      kind: "ask",
    });
    const renderId = renderAskCard(w.db, w.clock, {
      messageId: ask.messageId,
      agent: "ceo",
      persona: "Jarvis",
      project: undefined,
      channel: "C-dm",
      question: "q",
      options: ["Sì"],
    });
    expect((await w.daemon.answer(renderId, 7, "U1")).ok).toBe(false);
    w.db.close();
  });
});

describe("approve and deny", () => {
  it("decides a request's card and rewrites it", async () => {
    const w = daemon();
    w.approvals.request("ada", "merge_production", { branch: "master" });
    expect(await w.daemon.approve(1, 0, "once", "U1")).toEqual({ ok: true });
    expect(w.db.orm.select().from(schema.requests).all()[0]?.status).toBe("approved");
    expect(
      w.db.orm
        .select()
        .from(schema.events)
        .all()
        .map((e) => e.kind),
    ).toContain("card.decided");
    w.db.close();
  });

  it("refuses a click carrying an epoch the card has moved past", async () => {
    const w = daemon();
    w.approvals.request("ada", "merge_production", { branch: "master" });
    expect(await w.daemon.approve(1, 9, "once", "U1")).toEqual({ ok: false, reason: "stale" });
    expect(w.db.orm.select().from(schema.requests).all()[0]?.status).toBe("pending");
    w.db.close();
  });

  it("decides a held permission through the same button", async () => {
    const w = daemon();
    const pending = w.permissions.onPermission("ada", 1, {
      requestId: "r",
      toolUseId: "t",
      toolName: "Bash",
      input: { command: "npm test" },
      suggestions: undefined,
    });
    await Promise.resolve();
    expect(await w.daemon.approve(1, 0, "task", "U1")).toEqual({ ok: true });
    expect(await pending).toEqual({ behavior: "allow" });
    const row = w.db.orm.select().from(schema.permissionRequests).all()[0];
    expect(row?.status).toBe("allowed");
    expect(row?.scope).toBe("task");
    w.db.close();
  });
});

describe("reads", () => {
  it("diag names the last turn, its status and its cost", async () => {
    const w = daemon();
    w.db.orm
      .insert(schema.turns)
      .values({
        agent: "ceo",
        startedAt: w.clock.now(),
        status: "failed",
        sessionId: "s1",
        configVersion: "abcdef123456789",
        costMicrousd: 2_500_000,
        error: "process exited without a result",
      })
      .run();
    const out = await w.daemon.diag("ceo");
    expect(out).toContain("failed");
    expect(out).toContain("2.50 $ stimato");
    expect(out).toContain("process exited without a result");
    w.db.close();
  });

  it("diag says so when an agent has never run", async () => {
    const w = daemon();
    expect(await w.daemon.diag("ceo")).toMatch(/nessun turno/);
    w.db.close();
  });

  it("the Home shows each agent's month-to-date cost, summing turns exactly", async () => {
    const w = daemon();
    for (const cost of [1_000_000, 500_000]) {
      w.db.orm
        .insert(schema.turns)
        .values({
          agent: "ada",
          startedAt: w.clock.now(),
          status: "ok",
          sessionId: "s",
          configVersion: "v",
          costMicrousd: cost,
        })
        .run();
    }
    const view = JSON.stringify(await w.daemon.homeView("U1"));
    expect(view).toContain("1.50"); // 1.00 + 0.50, as integers
    expect(view).toContain("stimato");
    w.db.close();
  });

  it("details returns the payload behind the card, never the card itself", async () => {
    const w = daemon();
    w.approvals.request("ada", "merge_production", { branch: "master" });
    expect(await w.daemon.details(1)).toMatchObject({ branch: "master" });
    w.db.close();
  });

  it("currentText reads the file the modal pre-fills", async () => {
    const w = daemon();
    writeFileSync(join(w.home, "agents", "ceo", "MEMORY.md"), "contenuto\n");
    expect(await w.daemon.currentText("ceo", "MEMORY.md")).toBe("contenuto\n");
    w.db.close();
  });
});

describe("parked discoveries and retirement", () => {
  it("openParked hands the discovery to the lead rather than opening a task by itself", async () => {
    const w = daemon();
    const taskId = w.db.orm
      .insert(schema.tasks)
      .values({
        project: "agentopolis",
        title: "il lint è rotto",
        lead: "ada",
        status: "parked",
        openedAt: w.clock.now(),
      })
      .returning({ id: schema.tasks.id })
      .get().id;
    expect(await w.daemon.openParked(taskId)).toEqual({ ok: true });
    expect(w.woken).toContain("ada");
    expect(w.db.orm.select().from(schema.messages).all().at(-1)?.body).toContain("il lint è rotto");
    w.db.close();
  });

  it("refuses to open a task that is not parked", async () => {
    const w = daemon();
    w.db.orm
      .insert(schema.tasks)
      .values({
        project: "agentopolis",
        title: "t",
        lead: "ada",
        status: "open",
        openedAt: w.clock.now(),
      })
      .run();
    expect((await w.daemon.openParked(1)).ok).toBe(false);
    w.db.close();
  });

  it("retire marks the agent retired and stops it getting turns", async () => {
    const w = daemon();
    expect(await w.daemon.retire("ada")).toEqual({ ok: true });
    const row = w.db.orm.select().from(schema.agents).where(eq(schema.agents.name, "ada")).get();
    expect(row?.retiredAt).toBe(w.clock.now());
    expect(row?.paused).toBe(true);
    w.db.close();
  });
});

describe("hire", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN_PENNY = "";
    process.env.SLACK_APP_TOKEN_PENNY = "";
  });

  it("refuses a hire whose Slack app is not in config.yaml", async () => {
    const w = daemon();
    const r = await w.daemon.hire({
      role: "lead",
      project: "agentopolis",
      display: "Penny",
      model: undefined,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/app Slack/);
    w.db.close();
  });

  it("refuses a hire whose tokens are not in the environment", async () => {
    const w = daemon();
    const config = join(w.home, "config.yaml");
    writeFileSync(
      config,
      `${readFileSync(config, "utf8")}`.replace(
        "    ada: { bot_token_env: SLACK_BOT_TOKEN_ADA, app_token_env: SLACK_APP_TOKEN_ADA }",
        "    ada: { bot_token_env: SLACK_BOT_TOKEN_ADA, app_token_env: SLACK_APP_TOKEN_ADA }\n    penny: { bot_token_env: SLACK_BOT_TOKEN_PENNY, app_token_env: SLACK_APP_TOKEN_PENNY }",
      ),
    );
    w.holder.reload();
    const r = await w.daemon.hire({
      role: "lead",
      project: "agentopolis",
      display: "Penny",
      model: undefined,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/SLACK_BOT_TOKEN_PENNY/);
    expect(existsSync(join(w.home, "agents", "penny"))).toBe(false);
    w.db.close();
  });

  it("refuses to hire a job role: those are born with their task", async () => {
    const w = daemon();
    const r = await w.daemon.hire({
      role: "developer",
      project: "agentopolis",
      display: "Nuovo",
      model: undefined,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/compito/);
    w.db.close();
  });
});
