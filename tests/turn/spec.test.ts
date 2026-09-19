import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { FakeIds } from "../../src/ports/ids.js";
import * as schema from "../../src/store/schema.js";
import { ENVELOPE_JSON_SCHEMA } from "../../src/turn/envelope.js";
import {
  buildAgentsJson,
  buildTurnSpec,
  MAX_BUDGET_MICRO,
  MAX_TURNS,
  resolveRung,
} from "../../src/turn/spec.js";
import { jobAgent, world } from "./helpers.js";

const UUID = "22222222-2222-4222-8222-222222222222";
const runsDir = () => mkdtempSync(join(tmpdir(), "runs-"));
const opts = (over: Record<string, unknown> = {}) => ({
  turnId: 1,
  prompt: "ciao",
  runsDir: runsDir(),
  hookPath: "/t/hook.mjs",
  ...over,
});

describe("resolveRung", () => {
  const role = { model: "sonnet", effort: "high" } as never;
  it("prefers the instance override, then the task's rung, then the role default", () => {
    expect(resolveRung(role, "opus", "low", { model: "fable", effort: "medium" })).toEqual({
      model: "opus",
      effort: "low",
    });
    expect(resolveRung(role, null, null, { model: "fable", effort: "medium" })).toEqual({
      model: "fable",
      effort: "medium",
    });
    expect(resolveRung(role, null, null, undefined)).toEqual({ model: "sonnet", effort: "high" });
  });
});

describe("buildAgentsJson", () => {
  const research = {
    name: "research",
    description: "Read-only web research.",
    prompt: "Find what the caller asks for.",
    tools: ["WebSearch"],
    model: "sonnet",
  };

  it("is undefined when the role declares no subagent", () => {
    expect(buildAgentsJson([], undefined)).toBeUndefined();
  });

  it("carries description, prompt, tools and model, keyed by name", () => {
    const json = JSON.parse(buildAgentsJson([research], undefined) ?? "{}");
    expect(json.research).toEqual({
      description: "Read-only web research.",
      prompt: "Find what the caller asks for.",
      tools: ["WebSearch"],
      model: "sonnet",
    });
  });

  it("keeps research on Sonnet unless an approved request says otherwise (A3)", () => {
    const plain = JSON.parse(buildAgentsJson([research], undefined) ?? "{}");
    expect(plain.research.model).toBe("sonnet");
    const approved = JSON.parse(buildAgentsJson([research], { model: "opus" }) ?? "{}");
    expect(approved.research.model).toBe("opus");
  });

  it("is byte-stable: the same definitions give the same JSON", () => {
    const a = buildAgentsJson([research], undefined);
    const b = buildAgentsJson([research], undefined);
    expect(a).toBe(b);
  });
});

describe("buildTurnSpec", () => {
  it("allocates and stores the session id before the spawn, and resumes afterwards", () => {
    const w = world();
    const ids = new FakeIds([UUID]);
    const first = buildTurnSpec(w.snapshot, w.db, w.clock, ids, "ceo", opts());
    expect(first.sessionId).toBe(UUID);
    expect(first.resume).toBe(false);
    const row = w.db.orm.select().from(schema.agents).where(eq(schema.agents.name, "ceo")).get();
    expect(row?.sessionId).toBe(UUID);
    expect(row?.sessionStartedAt).toBe(w.clock.now());

    const second = buildTurnSpec(w.snapshot, w.db, w.clock, new FakeIds([]), "ceo", opts());
    expect(second.sessionId).toBe(UUID);
    expect(second.resume).toBe(true);
    w.db.close();
  });

  it("uses the daemon's fixed guards and the role's own wall clock", () => {
    const w = world();
    const s = buildTurnSpec(w.snapshot, w.db, w.clock, new FakeIds([UUID]), "ceo", opts());
    expect(s.maxTurns).toBe(MAX_TURNS);
    expect(s.maxBudgetMicro).toBe(MAX_BUDGET_MICRO);
    expect(s.wallClockMs).toBe(10 * 60_000); // the ceo fixture's max_minutes
    w.db.close();
  });

  it("passes the envelope schema with --json-schema, last on the command line", () => {
    const w = world();
    const s = buildTurnSpec(w.snapshot, w.db, w.clock, new FakeIds([UUID]), "ceo", opts());
    const at = s.extraArgs.indexOf("--json-schema");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(s.extraArgs[at + 1] ?? "{}")).toEqual(ENVELOPE_JSON_SCHEMA);
    w.db.close();
  });

  it("passes --agents only for a role that declares subagents", () => {
    const w = world();
    const ceo = buildTurnSpec(w.snapshot, w.db, w.clock, new FakeIds([UUID]), "ceo", opts());
    expect(ceo.extraArgs).not.toContain("--agents");

    const lead = buildTurnSpec(w.snapshot, w.db, w.clock, new FakeIds([UUID]), "ada", opts());
    const at = lead.extraArgs.indexOf("--agents");
    expect(at).toBeGreaterThanOrEqual(0);
    const agents = JSON.parse(lead.extraArgs[at + 1] ?? "{}");
    expect(agents.research.model).toBe("sonnet");
    expect(agents.research.prompt).toContain("Quote the page you read");
    w.db.close();
  });

  it("writes the system prompt to a file the CLI reads, style before the role's prose", () => {
    const w = world();
    const s = buildTurnSpec(w.snapshot, w.db, w.clock, new FakeIds([UUID]), "ceo", opts());
    expect(existsSync(s.systemPromptFile)).toBe(true);
    const text = readFileSync(s.systemPromptFile, "utf8");
    expect(text.indexOf("# Style")).toBeLessThan(text.indexOf("# Who you are"));
    w.db.close();
  });

  it("gives a standing agent its own folder as cwd and a job agent the project's repo", () => {
    const w = world();
    const standing = buildTurnSpec(w.snapshot, w.db, w.clock, new FakeIds([UUID]), "ada", opts());
    expect(standing.cwd).toBe(join(w.home, "agents", "ada"));

    jobAgent(w.db, { name: "dev-1", role: "developer", project: "agentopolis" });
    const job = buildTurnSpec(w.snapshot, w.db, w.clock, new FakeIds([UUID]), "dev-1", opts());
    expect(job.cwd).toBe("/tmp/agentopolis"); // the fixture project's repo
    w.db.close();
  });

  it("takes a job agent's rung from its task, and prefers a worktree once one exists", () => {
    const w = world();
    const taskId = w.db.orm
      .insert(schema.tasks)
      .values({
        project: "agentopolis",
        title: "t",
        lead: "ada",
        status: "open",
        model: "sonnet",
        effort: "medium",
        worktree: "/tmp/wt",
        openedAt: 1,
      })
      .returning({ id: schema.tasks.id })
      .get().id;
    jobAgent(w.db, { name: "dev-1", role: "developer", project: "agentopolis", taskId });
    const s = buildTurnSpec(w.snapshot, w.db, w.clock, new FakeIds([UUID]), "dev-1", opts());
    expect(s.model).toBe("sonnet");
    expect(s.effort).toBe("medium");
    expect(s.cwd).toBe("/tmp/wt");
    w.db.close();
  });

  it("carries the snapshot version, so a turn records which configuration ran it", () => {
    const w = world();
    const s = buildTurnSpec(w.snapshot, w.db, w.clock, new FakeIds([UUID]), "ceo", opts());
    expect(s.configVersion).toBe(w.snapshot.version);
    w.db.close();
  });

  it("carries the role's own permission rules into --settings", () => {
    const w = world();
    const s = buildTurnSpec(w.snapshot, w.db, w.clock, new FakeIds([UUID]), "ada", opts());
    expect(s.settings.permissions).toEqual({ allow: ["Bash(git *)", "Read"], deny: [] });
    w.db.close();
  });

  it("caps the effort through the CLI's own settings key, so no xhigh is enforced (8d)", () => {
    const w = world();
    const s = buildTurnSpec(w.snapshot, w.db, w.clock, new FakeIds([UUID]), "ada", opts());
    expect(s.settings.maxEffortLevel).toBe("high");
    w.db.close();
  });

  it("always loads the agentopolis MCP server", () => {
    const w = world();
    const s = buildTurnSpec(w.snapshot, w.db, w.clock, new FakeIds([UUID]), "ceo", opts());
    const servers = (s.mcpConfig as { mcpServers: Record<string, { alwaysLoad?: boolean }> })
      .mcpServers;
    expect(servers.agentopolis?.alwaysLoad).toBe(true);
    w.db.close();
  });

  it("refuses an agent with no role at all", () => {
    const w = world();
    expect(() =>
      buildTurnSpec(w.snapshot, w.db, w.clock, new FakeIds([UUID]), "ghost", opts()),
    ).toThrow(/ghost/);
    w.db.close();
  });
});
