import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMcpConfig } from "../../src/engine/mcp-config.js";
import { CliRunner } from "../../src/engine/runner.js";
import { mcpServerCommand } from "../../src/mcp/server-command.js";
import { startToolSocket } from "../../src/mcp/socket-server.js";
import type { ToolContext, ToolHandlers } from "../../src/mcp/tools.js";
import { FakeClock } from "../../src/ports/clock.js";
import type {
  PermissionDecision,
  PermissionRequest,
  RateLimitInfo,
  TurnSpec,
} from "../../src/ports/runner.js";
import { expectGone, FAKE, FIXTURES, makeSpec, SESSION } from "./helpers.js";

function setup(fixture: string, overrides: Partial<TurnSpec> = {}) {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  const argvOut = join(runsDir, "argv.json");
  const runner = new CliRunner({
    claudePath: "node",
    claudeArgs: [FAKE],
    runsDir,
    clock: new FakeClock(0),
    stopGraceMs: 200,
  });
  const spec = makeSpec({
    cwd: runsDir,
    env: { FAKE_CLAUDE_DIR: FIXTURES, FAKE_CLAUDE_FIXTURE: fixture, FAKE_CLAUDE_ARGV_OUT: argvOut },
    ...overrides,
  });
  const permissions: PermissionRequest[] = [];
  const rateLimits: RateLimitInfo[] = [];
  const activity: string[] = [];
  const events = (
    decision: PermissionDecision = { behavior: "deny", message: "in attesa del proprietario" },
  ) => ({
    onPermission: async (req: PermissionRequest) => {
      permissions.push(req);
      return decision;
    },
    onRateLimit: (info: RateLimitInfo) => {
      rateLimits.push(info);
    },
    onActivity: (kind: string) => {
      activity.push(kind);
    },
  });
  return { runner, spec, events, permissions, rateLimits, activity, runsDir, argvOut };
}

describe("CliRunner", () => {
  it("happy: records cost, cache, session and the run file; reports the rate limit", async () => {
    const t = setup("happy");
    const o = await t.runner.run(t.spec, t.events());
    expect(o.status).toBe("ok");
    expect(o.costMicro).toBe(2000);
    expect(o.costBasis).toBe("list");
    expect(o.cacheRead).toBe(100);
    expect(o.cacheCreation).toBe(10);
    expect(o.resultText).toBe("fatto");
    expect(o.sessionId).toBe(SESSION);
    expect(o.exitCode).toBe(0);
    expect(o.mcpStatus).toEqual({ agentopolis: "connected" });
    expect(o.runFile).toBe(join(t.runsDir, "1.ndjson"));
    expect(existsSync(o.runFile)).toBe(true);
    expect(
      readFileSync(o.runFile, "utf8").split("\n").filter(Boolean).length,
    ).toBeGreaterThanOrEqual(4);
    expect(t.rateLimits).toHaveLength(1);
    expect(t.rateLimits[0]?.windows.five_hour?.utilization).toBe(0.1);
    expect(o.rateLimit?.status).toBe("allowed");
    expect(t.activity).toContain("assistant");
  });

  it("writes the prompt as the first stdin line and the mcp config next to the run file", async () => {
    const t = setup("happy", { prompt: "ciao ceo", mcpConfig: { mcpServers: { x: 1 } } });
    await t.runner.run(t.spec, t.events());
    const mcp = JSON.parse(readFileSync(join(t.runsDir, "1.mcp.json"), "utf8"));
    expect(mcp).toEqual({ mcpServers: { x: 1 } });
    const argv = JSON.parse(readFileSync(t.argvOut, "utf8")) as string[];
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe(join(t.runsDir, "1.mcp.json"));
  });

  it("permission-parked: forwards the request and a deny lets the fake finish", async () => {
    const t = setup("permission-parked");
    const o = await t.runner.run(t.spec, t.events());
    expect(o.status).toBe("ok");
    expect(t.permissions).toHaveLength(1);
    expect(t.permissions[0]?.toolName).toBe("Bash");
    expect(t.permissions[0]?.input).toEqual({ command: "rm -rf /tmp/x" });
    expect(t.permissions[0]?.toolUseId).toBe("toolu_1");
  });

  it("permission-allowed: an allow is written back and accepted", async () => {
    const t = setup("permission-allowed");
    const o = await t.runner.run(t.spec, t.events({ behavior: "allow" }));
    expect(o.status).toBe("ok");
    expect(o.exitCode).toBe(0);
  });

  it("rate-limited: the limit event is surfaced, the turn fails with null cost", async () => {
    const t = setup("rate-limited");
    const o = await t.runner.run(t.spec, t.events());
    expect(t.rateLimits[0]?.status).toBe("limited");
    expect(t.rateLimits[0]?.resetsAt).toBe(1789750800);
    expect(o.status).toBe("failed");
    expect(o.costMicro).toBeNull();
    expect(o.error).toContain("rate_limit");
  });

  it("crash-no-result: failed, exit code 1, stderr in the error, null cost", async () => {
    const t = setup("crash-no-result");
    const o = await t.runner.run(t.spec, t.events());
    expect(o.status).toBe("failed");
    expect(o.exitCode).toBe(1);
    expect(o.error).toContain("boom");
    expect(o.costMicro).toBeNull();
  });

  it("max-budget and max-turns map to their statuses, with costs when given", async () => {
    const a = setup("max-budget");
    const oa = await a.runner.run(a.spec, a.events());
    expect(oa.status).toBe("budget_exhausted");
    expect(oa.costMicro).toBe(50_000);
    const b = setup("max-turns");
    const ob = await b.runner.run(b.spec, b.events());
    expect(ob.status).toBe("max_turns");
    expect(ob.costMicro).toBe(10_000);
  });

  it("pending-mcp is fine; failed-mcp stops the turn early", async () => {
    const p = setup("pending-mcp");
    expect((await p.runner.run(p.spec, p.events())).status).toBe("ok");
    const f = setup("failed-mcp");
    const started = Date.now();
    const o = await f.runner.run(f.spec, f.events());
    expect(o.status).toBe("failed");
    expect(o.error).toMatch(/agentopolis MCP server failed/);
    expect(o.mcpStatus.agentopolis).toBe("failed");
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("broken-line: one unparseable line is ignored", async () => {
    const t = setup("broken-line");
    const o = await t.runner.run(t.spec, t.events());
    expect(o.status).toBe("ok");
    expect(o.resultText).toBe("fatto");
  });

  it("hang: the wall-clock watchdog times the turn out and the grandchild dies", async () => {
    const t = setup("hang", { wallClockMs: 500 });
    const started = Date.now();
    const o = await t.runner.run(t.spec, t.events());
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(o.status).toBe("timed_out");
    expect(o.costMicro).toBeNull();
    const line = readFileSync(o.runFile, "utf8")
      .split("\n")
      .find((l) => l.includes("grandchild"));
    const g = (JSON.parse(line ?? "{}") as { grandchild: number }).grandchild;
    await expectGone(g);
  });

  it("no-session on --resume: failed with the CLI's message", async () => {
    const t = setup("no-session", { resume: true });
    const o = await t.runner.run(t.spec, t.events());
    expect(o.status).toBe("failed");
    expect(o.error).toContain("No conversation found");
    expect(o.exitCode).toBe(1);
  });

  it("argv never carries --bare/--continue and uses the stdio permission tool", async () => {
    const t = setup("happy");
    await t.runner.run(t.spec, t.events());
    const argv = JSON.parse(readFileSync(t.argvOut, "utf8")) as string[];
    expect(argv).not.toContain("--bare");
    expect(argv).not.toContain("--continue");
    expect(argv[argv.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
    expect(argv[argv.indexOf("--session-id") + 1]).toBe(SESSION);
  });

  it("extraArgs are appended after the built argv", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
    const argvOut = join(runsDir, "argv.json");
    const runner = new CliRunner({
      claudePath: "node",
      claudeArgs: [FAKE],
      runsDir,
      clock: new FakeClock(0),
      extraArgs: ["--json-schema", "{}"],
    });
    const spec = makeSpec({
      cwd: runsDir,
      env: {
        FAKE_CLAUDE_DIR: FIXTURES,
        FAKE_CLAUDE_FIXTURE: "happy",
        FAKE_CLAUDE_ARGV_OUT: argvOut,
      },
    });
    await runner.run(spec, { onPermission: async () => ({ behavior: "allow" }) });
    const argv = JSON.parse(readFileSync(argvOut, "utf8")) as string[];
    expect(argv.slice(-2)).toEqual(["--json-schema", "{}"]);
  });

  it("tool-call: the turn's MCP server reaches the daemon socket with the per-turn token", async () => {
    const t = setup("tool-call");
    const socketPath = join(t.runsDir, "daemon.sock");
    const seen: ToolContext[] = [];
    const status = { budget_left_usd: "9.99", open_asks: 0 };
    const noop = async () => null;
    const handlers: ToolHandlers = {
      post: noop,
      answer: noop,
      read_channel: noop,
      request: noop,
      remember: noop,
      status: async (ctx) => {
        seen.push(ctx);
        return status;
      },
    };
    const socket = await startToolSocket({
      path: socketPath,
      tokens: new Map([["turn-token-1", { agent: "ceo", turnId: 1 }]]),
      handlers,
    });
    const spec = {
      ...t.spec,
      mcpConfig: JSON.parse(buildMcpConfig(t.spec.role, {}, mcpServerCommand())),
      env: { ...t.spec.env, AGENTOPOLIS_SOCKET: socketPath, AGENTOPOLIS_TOKEN: "turn-token-1" },
    };
    try {
      const o = await t.runner.run(spec, t.events());
      expect(o.status).toBe("ok");
      expect(JSON.parse(o.resultText ?? "")).toEqual(status);
      expect(seen).toEqual([{ agent: "ceo", turnId: 1 }]);
      expect(o.costMicro).toBe(1000);
    } finally {
      await socket.close();
    }
  }, 20_000);
});
