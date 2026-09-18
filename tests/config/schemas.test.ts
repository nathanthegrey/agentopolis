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
  budget: { monthly_usd: 60, per_turn_usd: 5 },
  max_turns: 60,
  max_wall_clock_minutes: 45,
  talks_to: ["ceo", "owner", "developer"],
  requests: ["open_task", "close_task"],
};

describe("RoleFile", () => {
  it("accepts a valid role and applies defaults", () => {
    const r = RoleFile.parse(role);
    expect(r.kind).toBe("standing");
    expect(r.tools).toContain("agentopolis");
  });
  it("adds agentopolis to tools when omitted", () => {
    const r = RoleFile.parse({ ...role, tools: ["github"] });
    expect(r.tools).toEqual(["agentopolis", "github"]);
  });
  it("rejects an unknown kind and an unknown key", () => {
    expect(RoleFile.safeParse({ ...role, kind: "daemon" }).success).toBe(false);
    expect(RoleFile.safeParse({ ...role, colour: "red" }).success).toBe(false);
  });
  it("rejects a budget that is not positive", () => {
    expect(
      RoleFile.safeParse({ ...role, budget: { monthly_usd: 0, per_turn_usd: 5 } }).success,
    ).toBe(false);
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
      budget_monthly_usd: null,
      paused: false,
      session_id: null,
      session_started_at: null,
    });
    expect(a.paused).toBe(false);
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
      bot_token_env: "SLACK_BOT_TOKEN",
      app_token_env: "SLACK_APP_TOKEN",
      owner_user_id: "U0123ABCD",
      work_channel_suffix: "-work",
    },
    language: "it",
    budgets: { company_monthly_usd: 300 },
    approvals: { timeout_hours: 24, snooze_hours: 4 },
    quiet_hours: { from: "23:00", to: "08:00", tz: "Europe/Rome" },
    daily_digest_at: "08:30",
    max_concurrent_turns: 3,
    mcp_servers: {
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    },
  };
  it("accepts the spec example", () => {
    expect(ConfigFile.safeParse(config).success).toBe(true);
  });
  it("rejects a time that is not HH:MM", () => {
    expect(ConfigFile.safeParse({ ...config, daily_digest_at: "8h30" }).success).toBe(false);
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
