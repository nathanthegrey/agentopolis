import { describe, expect, it } from "vitest";
import { AgentFile, ConfigFile, ProjectFile, RoleFile } from "../../src/config/schemas.js";
import { findSecrets, looksLikeSecret } from "../../src/config/secret-detection.js";

const role = {
  name: "lead",
  description: "Runs one product's engineering.",
  kind: "standing",
  model: "opus",
  effort: "high",
  tools: ["agentopolis", "github"],
  disallowed_tools: ["Edit", "Write"],
  permissions: { mode: "acceptEdits", allow: ["Bash(git *)"], deny: [], hooks: [] },
  max_minutes: 45,
  talks_to: ["ceo", "owner", "developer"],
  requests: ["open_task", "close_task"],
};

describe("RoleFile", () => {
  it("accepts a valid role and applies defaults", () => {
    const r = RoleFile.parse(role);
    expect(r.kind).toBe("standing");
    expect(r.tools).toContain("agentopolis");
    expect(r.subagents).toEqual([]);
    expect(r.menu).toBeUndefined();
  });
  it("adds agentopolis to tools when omitted", () => {
    const r = RoleFile.parse({ ...role, tools: ["github"] });
    expect(r.tools).toEqual(["agentopolis", "github"]);
  });
  it("defaults max_minutes to 45 (spec section 4: the only guard a role configures)", () => {
    const { max_minutes: _omit, ...withoutGuard } = role;
    expect(RoleFile.parse(withoutGuard).max_minutes).toBe(45);
    expect(RoleFile.parse({ ...role, max_minutes: 10 }).max_minutes).toBe(10);
    expect(RoleFile.safeParse({ ...role, max_minutes: 0 }).success).toBe(false);
  });
  it("rejects the budget and turn knobs the spec removed", () => {
    expect(
      RoleFile.safeParse({ ...role, budget: { monthly_usd: 60, per_turn_usd: 5 } }).success,
    ).toBe(false);
    expect(RoleFile.safeParse({ ...role, max_turns: 60 }).success).toBe(false);
    expect(RoleFile.safeParse({ ...role, max_wall_clock_minutes: 45 }).success).toBe(false);
  });
  it("carries a job role's menu and rejects a value outside low/medium/high", () => {
    const r = RoleFile.parse({
      ...role,
      kind: "job",
      menu: { models: ["sonnet", "opus"], efforts: ["medium", "high"] },
    });
    expect(r.menu).toEqual({ models: ["sonnet", "opus"], efforts: ["medium", "high"] });
    expect(
      RoleFile.safeParse({ ...role, menu: { models: ["sonnet"], efforts: ["turbo"] } }).success,
    ).toBe(false);
  });
  it("never accepts xhigh, as an effort or in a menu (owner, 2026-09-19)", () => {
    expect(RoleFile.safeParse({ ...role, effort: "xhigh" }).success).toBe(false);
    expect(
      RoleFile.safeParse({ ...role, menu: { models: ["opus"], efforts: ["high", "xhigh"] } })
        .success,
    ).toBe(false);
  });
  it("carries the subagent names passed with --agents", () => {
    expect(RoleFile.parse({ ...role, subagents: ["research"] }).subagents).toEqual(["research"]);
  });
  it("accepts only the three v1 request kinds (spec section 8)", () => {
    expect(
      RoleFile.parse({ ...role, requests: ["open_task", "close_task", "merge_production"] })
        .requests,
    ).toEqual(["open_task", "close_task", "merge_production"]);
    expect(RoleFile.safeParse({ ...role, requests: ["set_budget"] }).success).toBe(false);
    expect(RoleFile.safeParse({ ...role, requests: ["hire"] }).success).toBe(false);
  });
  it("rejects an unknown kind and an unknown key", () => {
    expect(RoleFile.safeParse({ ...role, kind: "daemon" }).success).toBe(false);
    expect(RoleFile.safeParse({ ...role, colour: "red" }).success).toBe(false);
  });
});

describe("AgentFile", () => {
  it("accepts nulls for overrides", () => {
    const a = AgentFile.parse({
      name: "agentopolis-lead",
      display: "Leo · lead Agentopolis",
      avatar: "https://example.test/leo.png",
      role: "lead",
      project: "agentopolis",
      reports_to: "ceo",
      model: null,
      effort: null,
      paused: false,
      session_id: null,
      session_started_at: null,
    });
    expect(a.paused).toBe(false);
  });
  it("rejects budget_monthly_usd, which the spec removed", () => {
    expect(
      AgentFile.safeParse({
        name: "ada",
        display: "Ada",
        role: "lead",
        reports_to: "jarvis",
        budget_monthly_usd: 60,
      }).success,
    ).toBe(false);
  });
  it("accepts slack_app for a standing agent", () => {
    const a = AgentFile.parse({
      name: "ada",
      display: "Ada",
      role: "lead",
      reports_to: "jarvis",
      slack_app: "ada",
    });
    expect(a.slack_app).toBe("ada");
    expect(
      AgentFile.parse({ name: "nina", display: "Nina", role: "developer", reports_to: "ada" })
        .slack_app,
    ).toBeUndefined();
  });
  it("requires a lowercase slug name", () => {
    expect(
      AgentFile.safeParse({ name: "Leo Lead", display: "x", role: "lead", reports_to: "ceo" })
        .success,
    ).toBe(false);
  });
});

describe("ProjectFile", () => {
  it("requires distinct work and production branches", () => {
    const ok = ProjectFile.safeParse({
      slug: "agentopolis",
      name: "Agentopolis",
      repo: "/tmp/agentopolis",
      branches: { work: "dev", production: "master" },
      lead: "agentopolis-lead",
    });
    expect(ok.success).toBe(true);
    const same = ProjectFile.safeParse({
      slug: "agentopolis",
      name: "Agentopolis",
      repo: "/tmp/agentopolis",
      branches: { work: "master", production: "master" },
      lead: "agentopolis-lead",
    });
    expect(same.success).toBe(false);
  });
});

describe("ConfigFile", () => {
  const config = {
    slack: {
      owner_user_id: "U0123ABCD",
      work_channel_suffix: "-work",
      apps: {
        company: { bot_token_env: "SLACK_BOT_TOKEN", app_token_env: "SLACK_APP_TOKEN" },
        ada: { bot_token_env: "SLACK_BOT_TOKEN_ADA", app_token_env: "SLACK_APP_TOKEN_ADA" },
      },
    },
    language: "it",
    approvals: { timeout_hours: 24 },
    permission_hold_minutes: 5,
    gated: { models: ["fable"], research: { models: ["opus", "fable"], effort: true } },
    loop_guard: { messages: 12, review_rejections: 3 },
    job_names: ["Nina", "Marco"],
    max_concurrent_turns: 3,
    mcp_servers: {
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    },
  };
  it("accepts the spec example", () => {
    expect(ConfigFile.safeParse(config).success).toBe(true);
  });
  it("rejects the budgets and the digest time the spec removed", () => {
    expect(ConfigFile.safeParse({ ...config, budgets: { company_monthly_usd: 300 } }).success).toBe(
      false,
    );
    expect(ConfigFile.safeParse({ ...config, daily_digest_at: "08:30" }).success).toBe(false);
  });
  it("defaults the hold, the gated values and the loop guard (owner decisions D1, A3, A5)", () => {
    const { permission_hold_minutes: _h, gated: _g, loop_guard: _l, ...bare } = config;
    const c = ConfigFile.parse(bare);
    expect(c.permission_hold_minutes).toBe(5);
    expect(c.gated).toEqual({
      models: ["fable"],
      research: { models: ["opus", "fable"], effort: true },
    });
    expect(c.loop_guard).toEqual({ messages: 12, review_rejections: 3 });
  });
  it("rejects a hold or a loop-guard count that is not positive", () => {
    expect(ConfigFile.safeParse({ ...config, permission_hold_minutes: 0 }).success).toBe(false);
    expect(
      ConfigFile.safeParse({ ...config, loop_guard: { messages: 0, review_rejections: 3 } })
        .success,
    ).toBe(false);
  });
  it("slack.apps must include company; extra apps are fine", () => {
    const { apps } = config.slack;
    expect(
      ConfigFile.safeParse({ ...config, slack: { ...config.slack, apps: { ada: apps.ada } } })
        .success,
    ).toBe(false);
    expect(ConfigFile.parse(config).slack.apps.ada?.bot_token_env).toBe("SLACK_BOT_TOKEN_ADA");
  });
  it("job_names defaults to an empty list; snooze_hours and quiet_hours are gone", () => {
    const { job_names: _omit, ...withoutNames } = config;
    expect(ConfigFile.parse(withoutNames).job_names).toEqual([]);
    expect(ConfigFile.parse(config).job_names).toEqual(["Nina", "Marco"]);
    expect(
      ConfigFile.safeParse({ ...config, approvals: { timeout_hours: 24, snooze_hours: 4 } })
        .success,
    ).toBe(false);
    expect(
      ConfigFile.safeParse({
        ...config,
        quiet_hours: { from: "23:00", to: "08:00", tz: "Europe/Rome" },
      }).success,
    ).toBe(false);
  });
});

describe("secrets", () => {
  it("recognises Slack token shapes", () => {
    expect(looksLikeSecret("xoxb-123-abc")).toBe(true);
    expect(looksLikeSecret("xapp-1-A-abc")).toBe(true);
    expect(looksLikeSecret("SLACK_BOT_TOKEN")).toBe(false);
  });
  it("finds a token anywhere in a parsed document", () => {
    expect(findSecrets({ slack: { bot_token_env: "xoxb-1-2" }, list: ["ok", "xapp-9"] })).toEqual([
      "slack.bot_token_env",
      "list[1]",
    ]);
  });
});
