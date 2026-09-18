# Slice 2: engine — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Merge to `master` only when the supervisor's message contains the word "merge" as an instruction; a review that lists fixes is not a merge instruction.**

**Goal:** run one agent turn as one `claude -p` process, safely: build its arguments from the
snapshot, spawn it in a process group, read its NDJSON stream, answer permission requests on the
control channel (rules first, otherwise parked for the owner), record cost and session, stop it
on a wall clock, and never invoke the real CLI in CI.

**Architecture:** `src/engine/` is pure where it can be (argv, prompt composition, MCP config,
settings, protocol parsing, permission rules) and has one impure module for the child process.
`CliRunner` implements the `AgentRunner` port and is exercised by a `fake-claude` script that
replays fixtures, including pathologies. `src/mcp/` is the per-turn stdio MCP server that
forwards tool calls over a unix socket to the daemon; the daemon side is a small socket server
with a per-turn token. Nothing here touches Slack; the router (slice 4) will call `run()`.

**Tech Stack:** as slice 1, plus `@modelcontextprotocol/sdk` (approved by the supervisor for
this slice; spec section 16 is updated accordingly).

**Spec:** `docs/superpowers/specs/2026-09-18-agentopolis-v1-design.md`, sections 7, 8, 10,
13, 18. Roadmap: `docs/superpowers/plans/2026-09-18-agentopolis-v1-roadmap.md`.

## Global Constraints

- Branch `slice/02-engine` from `master` (after PR #1's merge, `7a9eb9a`). PR at the end.
- The real `claude` binary is never executed by `pnpm test`. Only `pnpm test:live` (guarded by
  `AGENTOPOLIS_LIVE=1`) and the live-check script touch it, by hand, on the owner's Mac, and
  they run Haiku with `--max-budget-usd 0.05`.
- Never `--bare`, never `--continue` (spec 7).
- Every spawn: `detached: true`, own process group, killed as a group; stdout drained
  continuously; finalise on `close`.
- "Process exited without a `result` line" is the single failure predicate; cost is `null` then.
- Money integer micro-USD; time through `Clock`; ids through `Ids` (slice 1).
- Verify every library API against the installed version, record versions in the report.
- Stage explicit paths; commit after every green step; Biome clean before the report.

## File structure

```
src/ports/runner.ts          AgentRunner port: TurnSpec, TurnOutcome, PermissionRequest/Decision, RunnerEvents
src/engine/protocol.ts       zod schemas for stream messages; parseLine(); result mapping
src/engine/argv.ts           buildArgv(spec) → string[]; ENV constants
src/engine/mcp-config.ts     byte-stable MCP config JSON for a role
src/engine/settings.ts       per-turn --settings JSON (permissions + PreToolUse hook)
src/engine/prompt.ts         composeSystemPrompt(), composeFirstUserMessage(), composeTurnPrompt()
src/engine/permissions.ts    rule matching (allow/deny patterns) → allow | deny | parked
src/engine/process.ts        spawnClaude(): process group, line reader, stdin writer, stop()
src/engine/runner.ts         CliRunner: run(spec, events) → TurnOutcome (state machine, watchdog)
src/mcp/socket-server.ts     daemon side: unix socket JSON-lines server, per-turn token, ToolHandlers port
src/mcp/server.ts            agentopolis-mcp: stdio MCP server forwarding tools to the socket
hooks/pre-tool-use.mjs       PreToolUse hook: exit 2 on git push to a production branch
tools/fake-claude/fake-claude.mjs   replays a fixture as a claude -p process
tools/fake-claude/fixtures/*.json   scripted streams (see Task 6)
tools/live-checks/run.ts     spec section 18 checks 3–6, by hand
tests/engine/*.test.ts, tests/mcp/*.test.ts, tests/hooks/*.test.ts
tests/contract/cli.contract.test.ts   dual target: fake by default, real with AGENTOPOLIS_LIVE=1
```

---

### Task 1: the runner port and the protocol parser

**Files:**
- Create: `src/ports/runner.ts`, `src/engine/protocol.ts`
- Test: `tests/engine/protocol.test.ts`

**Interfaces (produced, used by every later task):**

`src/ports/runner.ts`:

```ts
import type { AgentFile, ProjectFile } from "../config/schemas.js";
import type { Role } from "../config/loader.js";

export type TurnSpec = {
  turnId: number;
  agent: string;
  role: Role;
  instance: AgentFile;
  project: ProjectFile | undefined;
  cwd: string;
  sessionId: string;            // allocated by the daemon before spawn
  resume: boolean;              // false on the session's first turn
  systemPromptFile: string;     // path written by the caller (prompt.ts)
  prompt: string;               // the turn's user message (new messages, outcomes, memory lines)
  mcpConfig: Record<string, unknown>;
  settings: Record<string, unknown>;
  model: string;
  effort: string | undefined;
  maxTurns: number;
  maxBudgetMicro: number;
  wallClockMs: number;
  env: Record<string, string>;  // AGENTOPOLIS_* for the MCP server, plus spec section 7 env
  configVersion: string;
};

export type PermissionRequest = {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  suggestions: unknown;
};
export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type RateLimitInfo = {
  status: string;
  resetsAt: number | undefined;
  windows: Record<string, { utilization: number; resetsAt: number | undefined }>;
};

export type TurnStatus =
  | "ok" | "failed" | "interrupted" | "timed_out" | "cancelled" | "budget_exhausted" | "max_turns";

export type TurnOutcome = {
  status: TurnStatus;
  sessionId: string;
  resultText: string | undefined;
  costMicro: number | null;
  costBasis: "list" | "managed" | "unknown" | null;
  modelUsage: unknown;
  cacheRead: number | null;
  cacheCreation: number | null;
  inputTokens: number | null;
  permissionDenials: unknown[];
  rateLimit: RateLimitInfo | undefined;
  mcpStatus: Record<string, string>;
  exitCode: number | null;
  signal: string | null;
  error: string | undefined;
  runFile: string;              // runs/<turnId>.ndjson
};

export interface RunnerEvents {
  onPermission(req: PermissionRequest): Promise<PermissionDecision>;
  onRateLimit?(info: RateLimitInfo): void;
  onActivity?(kind: "assistant" | "tool_use" | "tool_result"): void;
}

export interface AgentRunner {
  run(spec: TurnSpec, events: RunnerEvents): Promise<TurnOutcome>;
}
```

`src/engine/protocol.ts` exports: `StreamMessage` (a discriminated union), `parseLine(line:
string): StreamMessage | { type: "unparseable"; line: string }`, and `outcomeFromResult(msg):
Partial<TurnOutcome>`.

- [ ] **Step 1: Write the failing tests**

`tests/engine/protocol.test.ts` (shapes are those observed on Claude Code 2.1.276; the live
check in Task 11 re-records them):

```ts
import { describe, expect, it } from "vitest";
import { outcomeFromResult, parseLine } from "../../src/engine/protocol.js";

const init = `{"type":"system","subtype":"init","session_id":"s1","model":"claude-haiku-4-5-20251001","tools":["Bash","Read"],"mcp_servers":[{"name":"agentopolis","status":"connected"},{"name":"github","status":"pending"}],"apiKeySource":"none","cwd":"/tmp","permissionMode":"default","claude_code_version":"2.1.276"}`;
const rate = `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1789750800,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.46,"resetsAt":1789750800},"seven_day":{"utilization":0.49,"resetsAt":1790132400}}}}`;
const perm = `{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"git push origin master"},"permission_suggestions":[],"tool_use_id":"toolu_1"}}`;
const result = `{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1","num_turns":1,"duration_ms":1474,"total_cost_usd":0.0021,"usage":{"input_tokens":3,"output_tokens":5,"cache_read_input_tokens":14482,"cache_creation_input_tokens":188},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":3,"outputTokens":5,"cacheReadInputTokens":14482,"cacheCreationInputTokens":188,"costUSD":0.0021,"costBasis":"list"}},"permission_denials":[]}`;

describe("parseLine", () => {
  it("parses init with mcp statuses", () => {
    const m = parseLine(init);
    expect(m.type).toBe("system_init");
    if (m.type !== "system_init") return;
    expect(m.sessionId).toBe("s1");
    expect(m.mcpServers).toEqual({ agentopolis: "connected", github: "pending" });
    expect(m.apiKeySource).toBe("none");
  });
  it("parses a rate limit event into windows", () => {
    const m = parseLine(rate);
    expect(m.type).toBe("rate_limit");
    if (m.type !== "rate_limit") return;
    expect(m.info.windows.five_hour?.utilization).toBe(0.46);
    expect(m.info.resetsAt).toBe(1789750800);
  });
  it("parses a can_use_tool control request", () => {
    const m = parseLine(perm);
    expect(m.type).toBe("permission_request");
    if (m.type !== "permission_request") return;
    expect(m.request.requestId).toBe("r1");
    expect(m.request.toolName).toBe("Bash");
    expect(m.request.toolUseId).toBe("toolu_1");
  });
  it("maps a result to an outcome with integer money", () => {
    const m = parseLine(result);
    expect(m.type).toBe("result");
    if (m.type !== "result") return;
    const o = outcomeFromResult(m);
    expect(o.status).toBe("ok");
    expect(o.costMicro).toBe(2100);
    expect(o.costBasis).toBe("list");
    expect(o.cacheRead).toBe(14482);
    expect(o.resultText).toBe("ok");
  });
  it("maps result subtypes to statuses", () => {
    for (const [sub, status] of [["error_max_turns", "max_turns"], ["error_max_budget_usd", "budget_exhausted"], ["error_during_execution", "failed"]] as const) {
      const m = parseLine(result.replace('"subtype":"success"', `"subtype":"${sub}"`));
      if (m.type !== "result") throw new Error("not a result");
      expect(outcomeFromResult(m).status).toBe(status);
    }
  });
  it("keeps unknown types and broken lines without throwing", () => {
    expect(parseLine('{"type":"something_new","x":1}').type).toBe("unknown");
    expect(parseLine("{not json").type).toBe("unparseable");
    expect(parseLine("").type).toBe("unparseable");
  });
  it("a result without costs yields null money, never zero", () => {
    const m = parseLine(`{"type":"result","subtype":"error_during_execution","session_id":"s1","is_error":true}`);
    if (m.type !== "result") throw new Error("not a result");
    const o = outcomeFromResult(m);
    expect(o.costMicro).toBeNull();
    expect(o.cacheRead).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement `protocol.ts`**

```ts
import { z } from "zod";
import { toMicroUsd } from "../money.js";
import type { PermissionRequest, RateLimitInfo, TurnOutcome, TurnStatus } from "../ports/runner.js";

const Loose = z.looseObject({});

const Init = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z.array(z.looseObject({ name: z.string(), status: z.string() })).optional(),
  apiKeySource: z.string().optional(),
});

const RateLimit = z.looseObject({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.looseObject({
    status: z.string(),
    resetsAt: z.number().optional(),
    unifiedWindows: z.record(z.string(), z.looseObject({ utilization: z.number(), resetsAt: z.number().optional() })).optional(),
  }),
});

const ControlRequest = z.looseObject({
  type: z.literal("control_request"),
  request_id: z.string(),
  request: z.looseObject({
    subtype: z.string(),
    tool_name: z.string().optional(),
    input: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    permission_suggestions: z.unknown().optional(),
  }),
});

const ApiRetry = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("api_retry"),
  error: z.string().optional(),
  error_status: z.number().nullable().optional(),
  attempt: z.number().optional(),
});

const Result = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  session_id: z.string().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
  usage: z.looseObject({
    input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  }).optional(),
  modelUsage: z.record(z.string(), z.looseObject({ costBasis: z.string().optional() })).optional(),
  permission_denials: z.array(z.unknown()).optional(),
});

export type StreamMessage =
  | { type: "system_init"; sessionId: string; model: string | undefined; tools: string[]; mcpServers: Record<string, string>; apiKeySource: string | undefined; raw: unknown }
  | { type: "rate_limit"; info: RateLimitInfo; raw: unknown }
  | { type: "permission_request"; request: PermissionRequest; raw: unknown }
  | { type: "control_request_other"; requestId: string; subtype: string; raw: unknown }
  | { type: "api_retry"; error: string | undefined; status: number | null | undefined; attempt: number | undefined; raw: unknown }
  | { type: "assistant"; raw: unknown }
  | { type: "user"; raw: unknown }
  | { type: "result"; subtype: string; raw: z.infer<typeof Result> }
  | { type: "unknown"; raw: unknown }
  | { type: "unparseable"; line: string };

export function parseLine(line: string): StreamMessage {
  if (line.trim() === "") return { type: "unparseable", line };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { type: "unparseable", line };
  }
  const loose = Loose.safeParse(raw);
  if (!loose.success) return { type: "unknown", raw };
  const t = (raw as { type?: string }).type;
  if (t === "system") {
    const i = Init.safeParse(raw);
    if (i.success) {
      const mcpServers: Record<string, string> = {};
      for (const s of i.data.mcp_servers ?? []) mcpServers[s.name] = s.status;
      return { type: "system_init", sessionId: i.data.session_id, model: i.data.model, tools: i.data.tools ?? [], mcpServers, apiKeySource: i.data.apiKeySource, raw };
    }
    const r = ApiRetry.safeParse(raw);
    if (r.success) return { type: "api_retry", error: r.data.error, status: r.data.error_status, attempt: r.data.attempt, raw };
    return { type: "unknown", raw };
  }
  if (t === "rate_limit_event") {
    const p = RateLimit.safeParse(raw);
    if (!p.success) return { type: "unknown", raw };
    const windows: RateLimitInfo["windows"] = {};
    for (const [k, v] of Object.entries(p.data.rate_limit_info.unifiedWindows ?? {})) {
      windows[k] = { utilization: v.utilization, resetsAt: v.resetsAt };
    }
    return { type: "rate_limit", info: { status: p.data.rate_limit_info.status, resetsAt: p.data.rate_limit_info.resetsAt, windows }, raw };
  }
  if (t === "control_request") {
    const p = ControlRequest.safeParse(raw);
    if (!p.success) return { type: "unknown", raw };
    if (p.data.request.subtype === "can_use_tool" && p.data.request.tool_name && p.data.request.tool_use_id) {
      return {
        type: "permission_request",
        request: { requestId: p.data.request_id, toolUseId: p.data.request.tool_use_id, toolName: p.data.request.tool_name, input: p.data.request.input, suggestions: p.data.request.permission_suggestions },
        raw,
      };
    }
    return { type: "control_request_other", requestId: p.data.request_id, subtype: p.data.request.subtype, raw };
  }
  if (t === "assistant") return { type: "assistant", raw };
  if (t === "user") return { type: "user", raw };
  if (t === "result") {
    const p = Result.safeParse(raw);
    if (!p.success) return { type: "unknown", raw };
    return { type: "result", subtype: p.data.subtype, raw: p.data };
  }
  return { type: "unknown", raw };
}

const STATUS: Record<string, TurnStatus> = {
  success: "ok",
  error_max_turns: "max_turns",
  error_max_budget_usd: "budget_exhausted",
  error_during_execution: "failed",
  error_max_structured_output_retries: "failed",
};

export function outcomeFromResult(m: Extract<StreamMessage, { type: "result" }>): Partial<TurnOutcome> {
  const r = m.raw;
  const basisValues = Object.values(r.modelUsage ?? {}).map((u) => u.costBasis);
  const costBasis = (basisValues.find((b) => b === "list" || b === "managed") ?? (basisValues.length ? "unknown" : null)) as TurnOutcome["costBasis"];
  return {
    status: STATUS[r.subtype] ?? "failed",
    resultText: r.result,
    costMicro: r.total_cost_usd === undefined ? null : toMicroUsd(r.total_cost_usd),
    costBasis,
    modelUsage: r.modelUsage ?? null,
    cacheRead: r.usage?.cache_read_input_tokens ?? null,
    cacheCreation: r.usage?.cache_creation_input_tokens ?? null,
    inputTokens: r.usage?.input_tokens ?? null,
    permissionDenials: r.permission_denials ?? [],
    ...(r.session_id ? { sessionId: r.session_id } : {}),
  };
}
```

- [ ] **Step 4: Run the tests** — Expected: PASS (7).

- [ ] **Step 5: Commit**

```bash
git add src/ports/runner.ts src/engine/protocol.ts tests/engine/protocol.test.ts
git commit -m "feat(engine): runner port and a tolerant parser for the CLI's stream-json protocol"
```

---

### Task 2: argv, MCP config and settings builders (pure)

**Files:**
- Create: `src/engine/argv.ts`, `src/engine/mcp-config.ts`, `src/engine/settings.ts`, `hooks/pre-tool-use.mjs`
- Test: `tests/engine/argv.test.ts`, `tests/engine/mcp-config.test.ts`, `tests/hooks/pre-tool-use.test.ts`

**Interfaces:**
- `buildArgv(spec: TurnSpec, paths: { mcpConfigFile: string; settingsJson: string }): string[]`
- `SPAWN_ENV: Record<string, string>` (the spec section 7 environment constants)
- `buildMcpConfig(role: Role, catalogue: ConfigFile["mcp_servers"], mcpServerCommand: { command: string; args: string[] }): string` — JSON with sorted keys, no whitespace variance, `agentopolis` first with `alwaysLoad: true`.
- `buildSettings(role: Role, production: string[] | undefined, hookPath: string): Record<string, unknown>` — `permissions.allow/deny` and a `PreToolUse` hook on `Bash` when the role's hooks include `deny_push_to_production`.

- [ ] **Step 1: Write the failing tests**

`tests/engine/argv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildArgv, SPAWN_ENV } from "../../src/engine/argv.js";
import { makeSpec } from "./helpers.js";

describe("buildArgv", () => {
  it("builds the exact argument list for a first turn", () => {
    const argv = buildArgv(makeSpec({ resume: false }), { mcpConfigFile: "/t/mcp.json", settingsJson: "{}" });
    expect(argv).toEqual([
      "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
      "--session-id", "11111111-1111-4111-8111-111111111111",
      "--model", "sonnet", "--effort", "low",
      "--max-turns", "20", "--max-budget-usd", "1",
      "--permission-mode", "default",
      "--disallowedTools", "Edit,Write,NotebookEdit,Bash",
      "--permission-prompt-tool", "stdio", "--permission-prompts", "host",
      "--setting-sources", "", "--settings", "{}",
      "--mcp-config", "/t/mcp.json", "--strict-mcp-config",
      "--append-system-prompt-file", "/t/system.md",
      "--system-prompt-snapshot", "off", "--exclude-dynamic-system-prompt-sections",
      "--name", "ceo",
    ]);
  });
  it("uses --resume on later turns and omits --effort when unset", () => {
    const argv = buildArgv(makeSpec({ resume: true, effort: undefined }), { mcpConfigFile: "/t/mcp.json", settingsJson: "{}" });
    expect(argv).toContain("--resume");
    expect(argv).not.toContain("--session-id");
    expect(argv).not.toContain("--effort");
  });
  it("never emits --bare or --continue, and formats the budget without float noise", () => {
    const argv = buildArgv(makeSpec({ maxBudgetMicro: 123_456 }), { mcpConfigFile: "/t/mcp.json", settingsJson: "{}" });
    expect(argv).not.toContain("--bare");
    expect(argv).not.toContain("--continue");
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("0.123456");
  });
  it("pins the cache and compaction environment", () => {
    expect(SPAWN_ENV.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("1h");
    expect(SPAWN_ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("100000");
    expect(SPAWN_ENV.CLAUDE_CODE_STARTUP_FAILURE_RESULTS).toBe("1");
    expect(SPAWN_ENV.MCP_TIMEOUT).toBe("5000");
  });
});
```

`tests/engine/helpers.ts` exports `makeSpec(overrides: Partial<TurnSpec>): TurnSpec` built from
the `home-valid` fixture's ceo role/agent (load it with `loadHome`), with `sessionId`
`11111111-1111-4111-8111-111111111111`, `systemPromptFile: "/t/system.md"`, `cwd: "/t"`,
`maxBudgetMicro: 1_000_000`, `wallClockMs: 60_000`, `configVersion: "v"`, `env: {}`.

`tests/engine/mcp-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildMcpConfig } from "../../src/engine/mcp-config.js";
import { loadHome } from "../../src/config/loader.js";
import { fileURLToPath } from "node:url";

const home = loadHome(fileURLToPath(new URL("../fixtures/home-valid/", import.meta.url)));

describe("buildMcpConfig", () => {
  it("is byte-stable: same inputs, same string, keys sorted, agentopolis alwaysLoad", () => {
    if (!home.ok) throw new Error("fixture");
    const role = { ...home.snapshot.roles.get("ceo")!, tools: ["github", "agentopolis"] };
    const catalogue = { github: { command: "npx", args: ["-y", "srv"], env: {} } };
    const cmd = { command: "node", args: ["/x/mcp-server.mjs"] };
    const a = buildMcpConfig(role, catalogue, cmd);
    const b = buildMcpConfig({ ...role, tools: ["agentopolis", "github"] }, catalogue, cmd);
    expect(a).toBe(b);
    const parsed = JSON.parse(a) as { mcpServers: Record<string, { alwaysLoad?: boolean }> };
    expect(Object.keys(parsed.mcpServers)).toEqual(["agentopolis", "github"]);
    expect(parsed.mcpServers.agentopolis?.alwaysLoad).toBe(true);
  });
  it("refuses a tool the catalogue does not know", () => {
    if (!home.ok) throw new Error("fixture");
    const role = { ...home.snapshot.roles.get("ceo")!, tools: ["agentopolis", "ghost"] };
    expect(() => buildMcpConfig(role, {}, { command: "node", args: [] })).toThrow(/ghost/);
  });
});
```

`tests/hooks/pre-tool-use.test.ts` (runs the hook script as a child):

```ts
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hook = fileURLToPath(new URL("../../hooks/pre-tool-use.mjs", import.meta.url));
const run = (input: unknown, env: Record<string, string>) =>
  spawnSync("node", [hook], { input: JSON.stringify(input), env: { ...process.env, ...env }, encoding: "utf8" });

describe("pre-tool-use hook", () => {
  const env = { AGENTOPOLIS_PRODUCTION_BRANCHES: "master,main" };
  it("exits 2 on a push to a production branch", () => {
    const r = run({ tool_name: "Bash", tool_input: { command: "git push origin master" } }, env);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/production/);
  });
  it("exits 2 on a push with HEAD:master and on git add -A", () => {
    expect(run({ tool_name: "Bash", tool_input: { command: "git push -f origin HEAD:main" } }, env).status).toBe(2);
    expect(run({ tool_name: "Bash", tool_input: { command: "git add -A" } }, env).status).toBe(2);
  });
  it("exits 0 and says nothing on anything else, including a push to dev", () => {
    expect(run({ tool_name: "Bash", tool_input: { command: "git push origin dev" } }, env).status).toBe(0);
    expect(run({ tool_name: "Read", tool_input: { file_path: "x" } }, env).status).toBe(0);
  });
  it("exits 0 and logs when it cannot evaluate its predicate", () => {
    const r = run("not json", env);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/could not/i);
  });
});
```

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement**

`src/engine/argv.ts`:

```ts
import type { TurnSpec } from "../ports/runner.js";

export const SPAWN_ENV: Record<string, string> = {
  CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
  CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m",
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000",
  CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
  CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "30000",
  MCP_TIMEOUT: "5000",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

export function usdString(micro: number): string {
  // integer micro-USD → decimal string without float artefacts
  const whole = Math.floor(micro / 1_000_000);
  const frac = String(micro % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

export function buildArgv(spec: TurnSpec, paths: { mcpConfigFile: string; settingsJson: string }): string[] {
  const argv = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];
  argv.push(spec.resume ? "--resume" : "--session-id", spec.sessionId);
  argv.push("--model", spec.model);
  if (spec.effort) argv.push("--effort", spec.effort);
  argv.push("--max-turns", String(spec.maxTurns), "--max-budget-usd", usdString(spec.maxBudgetMicro));
  argv.push("--permission-mode", spec.role.permissions.mode);
  if (spec.role.permissions.allow.length) argv.push("--allowedTools", spec.role.permissions.allow.join(","));
  if (spec.role.disallowed_tools.length) argv.push("--disallowedTools", spec.role.disallowed_tools.join(","));
  argv.push("--permission-prompt-tool", "stdio", "--permission-prompts", "host");
  argv.push("--setting-sources", "", "--settings", paths.settingsJson);
  argv.push("--mcp-config", paths.mcpConfigFile, "--strict-mcp-config");
  argv.push("--append-system-prompt-file", spec.systemPromptFile);
  argv.push("--system-prompt-snapshot", "off", "--exclude-dynamic-system-prompt-sections");
  argv.push("--name", spec.agent);
  return argv;
}
```

`src/engine/mcp-config.ts`:

```ts
import type { Role } from "../config/loader.js";
import type { ConfigFile } from "../config/schemas.js";

type Catalogue = ConfigFile["mcp_servers"];

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}

export function buildMcpConfig(role: Role, catalogue: Catalogue, agentopolis: { command: string; args: string[] }): string {
  const servers: Record<string, unknown> = {
    agentopolis: { type: "stdio", command: agentopolis.command, args: agentopolis.args, alwaysLoad: true },
  };
  for (const name of [...role.tools].sort()) {
    if (name === "agentopolis") continue;
    const def = catalogue[name];
    if (!def) throw new Error(`role ${role.name} names MCP server "${name}" which config.yaml does not define`);
    servers[name] = { type: "stdio", command: def.command, args: def.args, env: def.env };
  }
  return JSON.stringify(sortKeys({ mcpServers: servers }));
}
```

`src/engine/settings.ts`:

```ts
import type { Role } from "../config/loader.js";

export function buildSettings(role: Role, productionBranches: string[] | undefined, hookPath: string): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    permissions: { allow: role.permissions.allow, deny: role.permissions.deny },
  };
  if (role.permissions.hooks.includes("deny_push_to_production") && productionBranches?.length) {
    settings.hooks = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: `AGENTOPOLIS_PRODUCTION_BRANCHES=${productionBranches.join(",")} node ${hookPath}`, timeout: 10 }],
        },
      ],
    };
  }
  return settings;
}
```

`hooks/pre-tool-use.mjs`:

```js
#!/usr/bin/env node
// PreToolUse hook. Exit 2 = hard deny (cannot be overridden). Exit 0 = no opinion.
// A hook that cannot evaluate its predicate says so on stderr and allows (spec principle 4).
import { readFileSync } from "node:fs";

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch (e) {
  console.error(`pre-tool-use: could not parse the hook payload (${e.message}); allowing`);
  process.exit(0);
}
if (payload?.tool_name !== "Bash" || typeof payload?.tool_input?.command !== "string") process.exit(0);
const command = payload.tool_input.command;
const production = (process.env.AGENTOPOLIS_PRODUCTION_BRANCHES ?? "").split(",").map((s) => s.trim()).filter(Boolean);

if (/\bgit\s+add\s+(-A|--all|\.)(\s|$)/.test(command)) {
  console.error("pre-tool-use: blind staging (git add -A / .) is refused; stage explicit paths");
  process.exit(2);
}
if (/\bgit\s+push\b/.test(command)) {
  for (const branch of production) {
    const re = new RegExp(`(\\s|:)${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`);
    if (re.test(command)) {
      console.error(`pre-tool-use: push to production branch "${branch}" is refused; ask the owner through merge_production`);
      process.exit(2);
    }
  }
}
process.exit(0);
```

- [ ] **Step 4: Run the tests** — Expected: PASS (4 + 2 + 4).

- [ ] **Step 5: Commit**

```bash
git add src/engine/argv.ts src/engine/mcp-config.ts src/engine/settings.ts hooks/pre-tool-use.mjs tests/engine/argv.test.ts tests/engine/helpers.ts tests/engine/mcp-config.test.ts tests/hooks/pre-tool-use.test.ts
git commit -m "feat(engine): argv builder, byte-stable MCP config, per-turn settings with the production-push hook"
```

---

### Task 3: prompt composition (pure)

**Files:**
- Create: `src/engine/prompt.ts`
- Test: `tests/engine/prompt.test.ts`

**Interfaces:**
- `composeSystemPrompt(style: string, role: Role): string` — exactly `STYLE.md`, then `SOUL.md`,
  `JOB.md`, `PROTOCOL.md`, each under a heading (`# Style`, `# Who you are`, `# Your job`,
  `# How you work with others`), joined with blank lines, trailing newline.
- `composeFirstUserMessage(parts: { memory: string; knowledge: { name: string; text: string }[]; state: string | undefined }): string` — `# Memory`, `# Project knowledge` (one `## <name>` per file, sorted by name), `# State pack` when present.
- `composeTurnPrompt(input: { messages: { container: string; author: string; kind: string; body: string; id: number }[]; outcomes: string[]; remembered: string[] }): string` — one section per container in id order (`## <container>`), each message as `[#id] author (kind): body`; then `# Outcomes` and `# Remembered since last turn` when non-empty; ends with the instruction line `Rispondi solo tramite gli strumenti agentopolis; non scrivere testo libero.`

- [ ] **Step 1: Write the failing tests** covering: order of sections, deterministic output for
  the same input (byte equality), sorted knowledge, empty optional sections omitted, message
  grouping by container in id order.

- [ ] **Step 2: Run to see them fail.** **Step 3: Implement** as pure string builders.
  **Step 4: Run** — PASS. **Step 5: Commit** `feat(engine): deterministic prompt composition`.

---

### Task 4: permission rules

**Files:**
- Create: `src/engine/permissions.ts`
- Test: `tests/engine/permissions.test.ts`

**Interfaces:**
- `matchRule(rule: string, toolName: string, input: unknown): boolean` — supports `Tool`,
  `Tool(*)`, `Bash(prefix *)` (prefix match with the space-star rule), `Bash(exact)`,
  `mcp__server__tool`, `mcp__server__*`.
- `decide(role: Role, req: PermissionRequest): "allow" | "deny" | "parked"` — deny rules first,
  then allow rules, otherwise parked.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { decide, matchRule } from "../../src/engine/permissions.js";

describe("matchRule", () => {
  it("matches bare tools and Bash prefixes with the space-star rule", () => {
    expect(matchRule("Read", "Read", {})).toBe(true);
    expect(matchRule("Bash(git diff *)", "Bash", { command: "git diff main" })).toBe(true);
    expect(matchRule("Bash(git diff *)", "Bash", { command: "git diff-index" })).toBe(false);
    expect(matchRule("Bash(git diff*)", "Bash", { command: "git diff-index" })).toBe(true);
    expect(matchRule("Bash(npm test)", "Bash", { command: "npm test" })).toBe(true);
    expect(matchRule("Bash(npm test)", "Bash", { command: "npm test --watch" })).toBe(false);
    expect(matchRule("mcp__github__*", "mcp__github__create_issue", {})).toBe(true);
  });
});

describe("decide", () => {
  const role = { permissions: { allow: ["Bash(git *)", "Read"], deny: ["Bash(git push *)"] } } as never;
  const req = (toolName: string, command: string) => ({ requestId: "r", toolUseId: "t", toolName, input: { command }, suggestions: undefined });
  it("deny beats allow; allow beats parked", () => {
    expect(decide(role, req("Bash", "git push origin dev"))).toBe("deny");
    expect(decide(role, req("Bash", "git status"))).toBe("allow");
    expect(decide(role, req("Bash", "rm -rf /"))).toBe("parked");
    expect(decide(role, req("WebFetch", ""))).toBe("parked");
  });
});
```

- [ ] **Step 2: Run to see them fail.** **Step 3: Implement.**

```ts
import type { Role } from "../config/loader.js";
import type { PermissionRequest } from "../ports/runner.js";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchRule(rule: string, toolName: string, input: unknown): boolean {
  const m = /^([^()]+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return false;
  const [, tool, spec] = m;
  const toolOk = tool === toolName || (tool!.endsWith("*") && toolName.startsWith(tool!.slice(0, -1)));
  if (!toolOk) return false;
  if (spec === undefined || spec === "*") return true;
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
  if (spec.endsWith(" *")) return command === spec.slice(0, -2) || command.startsWith(spec.slice(0, -1));
  if (spec.endsWith("*")) return command.startsWith(spec.slice(0, -1));
  return command === spec;
}

export function decide(role: Pick<Role, "permissions">, req: PermissionRequest): "allow" | "deny" | "parked" {
  if (role.permissions.deny.some((r) => matchRule(r, req.toolName, req.input))) return "deny";
  if (role.permissions.allow.some((r) => matchRule(r, req.toolName, req.input))) return "allow";
  return "parked";
}
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(engine): permission rule matching with deny-first, parked otherwise`.

---

### Task 5: the child process wrapper

**Files:**
- Create: `src/engine/process.ts`
- Test: `tests/engine/process.test.ts` with helper children under `tests/fixtures/children/`

**Interfaces:**
- `spawnLines(command: string, args: string[], opts: { cwd: string; env: Record<string, string>; onLine(line: string): void; onStderr(chunk: string): void; teeTo: string }): ChildHandle`
- `ChildHandle = { pid: number; writeLine(obj: unknown): void; endInput(): void; stop(graceMs: number): Promise<void>; closed: Promise<{ code: number | null; signal: string | null }> }`
- `stop()` sends SIGINT to the **process group**, waits `graceMs`, then SIGKILL to the group;
  `closed` resolves on the child's `close` event (all stdio flushed), never on `exit`.

- [ ] **Step 1: Write the helper children** (plain Node scripts):
  - `echo-lines.mjs`: prints three JSON lines with 50 ms gaps, then exits 0.
  - `slow-exit.mjs`: prints one line, then writes a final line 300 ms after `exit` would fire
    if stdout were unflushed (use `process.stdout.write` of 1 MB then exit) — asserts `close`
    ordering.
  - `ignore-sigint.mjs`: installs a SIGINT handler that does nothing and loops with a timer;
    spawns a grandchild `sleep 60` via `child_process.spawn` so the group kill is testable.
  - `echo-stdin.mjs`: for each stdin line, prints `{"echo":<line>}`; exits on stdin end.

- [ ] **Step 2: Write the failing tests**: lines arrive in order; a 1 MB burst is not lost
  (count bytes received before `closed` resolves); `writeLine`/`endInput` round-trip through
  `echo-stdin`; `stop(200)` on `ignore-sigint` resolves within ~1 s and the grandchild `sleep`
  is gone (`process.kill(gpid, 0)` throws ESRCH); the tee file contains every stdout line.

- [ ] **Step 3: Implement** with `child_process.spawn(command, args, { cwd, env, detached: true,
  stdio: ["pipe", "pipe", "pipe"] })`, `readline.createInterface({ input: child.stdout,
  crlfDelay: Infinity })`, `fs.createWriteStream(teeTo)`, and

```ts
async stop(graceMs) {
  try { process.kill(-child.pid, "SIGINT"); } catch {}
  const done = await Promise.race([closed.then(() => true), sleep(graceMs).then(() => false)]);
  if (!done) { try { process.kill(-child.pid, "SIGKILL"); } catch {} await closed; }
}
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(engine): process wrapper with process-group stop, line reader and tee`.

---

### Task 6: `fake-claude` and its fixtures

**Files:**
- Create: `tools/fake-claude/fake-claude.mjs`, `tools/fake-claude/fixtures/*.json`
- Test: `tests/engine/fake-claude.test.ts` (the fake obeys its own contract)

**Contract of the fake:** it is invoked exactly like `claude` (same argv). It reads
`FAKE_CLAUDE_FIXTURE` (a fixture name) and `FAKE_CLAUDE_DIR` (fixtures dir) from env. It
validates argv: rejects `--bare` and `--continue` with exit 3 and `error: unknown option`
(mirroring the real CLI's message shape), requires `--session-id` or `--resume`, and records the
argv it received to `FAKE_CLAUDE_ARGV_OUT` when set. A fixture is a JSON array of steps:

```json
[
  { "emit": { "type": "rate_limit_event", "rate_limit_info": { "status": "allowed", "unifiedWindows": { "five_hour": { "utilization": 0.1 } } } } },
  { "emit": { "type": "system", "subtype": "init", "session_id": "$SESSION", "mcp_servers": [{ "name": "agentopolis", "status": "connected" }] } },
  { "sleep": 20 },
  { "emit": { "type": "assistant", "message": { "content": [{ "type": "text", "text": "ciao" }] } } },
  { "await_control": { "request_id": "r1", "request": { "subtype": "can_use_tool", "tool_name": "Bash", "input": { "command": "rm -rf /tmp/x" }, "tool_use_id": "toolu_1" } }, "expect": "deny" },
  { "emit": { "type": "result", "subtype": "success", "result": "fatto", "session_id": "$SESSION", "total_cost_usd": 0.002, "usage": { "input_tokens": 3, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 10 }, "modelUsage": { "m": { "costUSD": 0.002, "costBasis": "list" } }, "permission_denials": [] } },
  { "exit": 0 }
]
```

Step kinds: `emit` (write the object as one line; `$SESSION` is replaced by the session id from
argv), `sleep` (ms), `await_control` (write the `control_request`, then block until a
`control_response` with that `request_id` arrives on stdin; if `expect` is given and the
behavior differs, exit 4), `emit_raw` (write the string verbatim, for broken lines), `hang`
(never exit; ignore SIGINT when `ignore_sigint: true`), `exit` (code). `spawn_grandchild`
starts `sleep 60` so group kill is observable.

Fixtures to write (names are the contract for Tasks 7–8):
- `happy.json` — the example above without the control step.
- `permission-parked.json` — the example above (expects `deny`).
- `permission-allowed.json` — same request with `git status`, expects `allow`.
- `rate-limited.json` — `rate_limit_event` with `status: "limited"`, `resetsAt`, then an
  `api_retry` with `error: "rate_limit"`, then a result `error_during_execution` without costs.
- `crash-no-result.json` — init, assistant, `exit 1` with stderr text `boom`.
- `max-budget.json` — result subtype `error_max_budget_usd` with costs.
- `max-turns.json` — result subtype `error_max_turns`.
- `pending-mcp.json` — init where `agentopolis` is `pending` and the run succeeds.
- `failed-mcp.json` — init where `agentopolis` is `failed`.
- `broken-line.json` — one `emit_raw` of `{not json` between assistant and result.
- `hang.json` — init then `hang` with `ignore_sigint: true` and a grandchild.
- `no-session.json` — for a `--resume`: writes `No conversation found with session ID: x` to
  stderr and exits 1 with no init.

- [ ] **Step 1: Write the fake and one test per fixture kind** proving the fake itself: emits
  lines in order, replaces `$SESSION`, blocks on `await_control` until answered, rejects
  `--bare`, records argv.

- [ ] **Step 2: Run** — PASS. **Step 3: Commit** `test(engine): fake-claude with scripted fixtures including pathologies`.

---

### Task 7: `CliRunner`

**Files:**
- Create: `src/engine/runner.ts`
- Test: `tests/engine/runner.test.ts` (against `fake-claude`, one test per fixture)

**Interfaces:**
- `class CliRunner implements AgentRunner { constructor(opts: { claudePath: string; runsDir: string; clock: Clock; sleep?: (ms) => Promise<void> }) }`
- `run(spec, events)` behaviour, in order:
  1. Write `spec.mcpConfig` to `<runsDir>/<turnId>.mcp.json` and build argv with
     `settingsJson = JSON.stringify(spec.settings)`.
  2. Spawn with `env = { ...process.env, ...SPAWN_ENV, ...spec.env }` (spec env wins), tee to
     `<runsDir>/<turnId>.ndjson`.
  3. Write the turn's user message as the first stdin line
     `{"type":"user","message":{"role":"user","content":[{"type":"text","text": prompt}]}}` and
     `endInput()`.
  4. Start the wall-clock watchdog (`spec.wallClockMs`): on fire, `stop(10_000)` and status
     `timed_out`.
  5. For every parsed line: `rate_limit` → `events.onRateLimit`; `system_init` → record
     `mcpStatus`; if `mcpStatus.agentopolis` is `failed` or `needs-auth` → `stop(2_000)`,
     status `failed`, error `agentopolis MCP server <status>`; `permission_request` → `await
     events.onPermission(req)` and write `{"type":"control_response","response":{"subtype":
     "success","request_id":req.requestId,"response":decision}}`; `assistant`/`user` →
     `events.onActivity`; `result` → merge `outcomeFromResult`; `unparseable` → count and
     continue; `api_retry` → remember the last error string.
  6. On `closed`: if no `result` line was seen and status is not already `timed_out`/`failed`
     from step 5, status `failed`, cost `null`, error = stderr tail (last 2,000 chars) or
     `exited without result`; `exitCode`, `signal` filled; return the outcome with `runFile`.
  - The runner never re-runs and never sleeps between steps; the caller decides retries.

- [ ] **Step 1: Write the failing tests** (each builds a `TurnSpec` with `makeSpec` and points
  `claudePath` at the fake; `env.FAKE_CLAUDE_FIXTURE` selects the fixture):

  - `happy`: status `ok`, `costMicro` 2000, `cacheRead` 100, `resultText` "fatto",
    `sessionId` equals the spec's, run file exists and has ≥ 4 lines, `onRateLimit` called once
    with utilization 0.1.
  - `permission-parked`: `onPermission` receives toolName `Bash` and the input; returning
    `{ behavior: "deny", message: "in attesa del proprietario" }` lets the fake finish; status `ok`.
  - `permission-allowed`: returning `{ behavior: "allow" }` is accepted (fake exit 0).
  - `rate-limited`: `onRateLimit` sees `status: "limited"`; status `failed`; `costMicro` null.
  - `crash-no-result`: status `failed`, `exitCode` 1, error contains `boom`, cost null.
  - `max-budget`: status `budget_exhausted` with costs; `max-turns`: status `max_turns`.
  - `pending-mcp`: status `ok`; `failed-mcp`: status `failed`, error mentions `failed`.
  - `broken-line`: status `ok` (one unparseable line ignored).
  - `hang` with `wallClockMs: 500`: status `timed_out` within 2 s, and the grandchild is dead.
  - `no-session` with `resume: true`: status `failed`, error contains `No conversation found`.
  - argv recorded by the fake never contains `--bare`/`--continue` and contains
    `--permission-prompt-tool stdio`.

- [ ] **Step 2: Run to see them fail.** **Step 3: Implement the runner** as a small state
  machine over the process wrapper; keep it under ~200 lines; no retries, no sleeps except the
  watchdog.

- [ ] **Step 4: Run** — PASS (12). **Step 5: Commit** `feat(engine): CliRunner runs one turn as one process with watchdog, control channel and cost recording`.

---

### Task 8: the daemon-side tool socket and the stdio MCP server

**Files:**
- Create: `src/mcp/socket-server.ts`, `src/mcp/server.ts`, `src/mcp/tools.ts` (tool
  definitions shared by both sides)
- Test: `tests/mcp/socket.test.ts`, `tests/mcp/server.test.ts`

**Interfaces:**
- `src/mcp/tools.ts`: the six tools of spec section 8 as `{ name, description, inputSchema
  (zod) }`: `post`, `answer`, `read_channel`, `request`, `remember`, `status`.
- `ToolHandlers` port: `{ [name]: (ctx: { agent: string; turnId: number }, input) =>
  Promise<unknown> }`.
- `startToolSocket(opts: { path: string; tokens: Map<string, { agent: string; turnId: number
  }>; handlers: ToolHandlers }): { close(): Promise<void> }` — JSON lines over
  `net.createServer`; first line from a client must be `{"hello":{"token":…}}`; unknown token →
  close; then `{"id","tool","input"}` → `{"id","result"}` or `{"id","error"}`.
- `src/mcp/server.ts`: a `@modelcontextprotocol/sdk` stdio server (`McpServer` +
  `StdioServerTransport`) registering the six tools; each handler connects to
  `AGENTOPOLIS_SOCKET` with `AGENTOPOLIS_TOKEN`, forwards, returns the result as one text
  content block (JSON). Errors return `isError: true` with the message; never throw.

- [ ] **Step 1: Write the failing tests**: socket rejects a bad token; dispatches `post` to the
  handler with the right ctx; the MCP server, spawned as a child with the SDK's `Client` over
  `StdioClientTransport`, lists six tools and a `tools/call` of `status` reaches the fake handler
  and returns its JSON.

- [ ] **Step 2: Run to see them fail.** **Step 3: Implement.** Check the installed SDK's API
  (`node_modules/@modelcontextprotocol/sdk/README.md`) for `McpServer.registerTool` /
  `server.tool` and adapt; record which in the report.

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(mcp): per-turn stdio MCP server forwarding tools over a token-checked unix socket`.

---

### Task 9: wiring `spec.env` and the MCP server command

**Files:**
- Modify: `src/engine/runner.ts` (compose `env` from spec: `AGENTOPOLIS_SOCKET`,
  `AGENTOPOLIS_TOKEN`, `AGENTOPOLIS_TURN_ID`, `AGENTOPOLIS_AGENT`), `src/engine/mcp-config.ts`
  callers use `{ command: "node", args: [<abs path of dist or tsx entry of src/mcp/server.ts>] }`
- Test: `tests/engine/runner.test.ts` — one end-to-end test: fake fixture `tool-call.json`
  (new) in which the fake, instead of emitting, spawns the real `agentopolis-mcp` server with
  the env it received and calls `status` over stdio (the fake includes a tiny MCP client using
  the SDK), then emits a result whose `result` text is the tool's JSON; the test starts the
  tool socket with a fake `status` handler and asserts the round trip.

- [ ] Steps: failing test → implement → PASS → commit `feat(engine): a turn's MCP server reaches the daemon socket with its per-turn token`.

---

### Task 10: the contract suite, dual target

**Files:**
- Create: `tests/contract/cli.contract.test.ts`, script `test:live` in `package.json`
  (`AGENTOPOLIS_LIVE=1 vitest run tests/contract`)

**Behaviour:** the suite runs `CliRunner` for the `happy` scenario. Default target: the fake.
With `AGENTOPOLIS_LIVE=1`: `claudePath: "claude"`, model `haiku`, `maxBudgetMicro: 50_000`,
`maxTurns: 2`, prompt `Rispondi con la sola parola: ok`, a temporary home from `examples/home`,
the real `agentopolis-mcp` server, `cwd` a temp dir. Assertions valid on both targets: status
`ok`, `resultText` contains `ok`, `sessionId` equals the spec's, `costMicro` is a non-negative
integer or null, the run file has a `system`/`init` line and a `result` line, `mcpStatus.
agentopolis` is `connected` or `pending`. On the live target, a second run with `resume: true`
must show `cacheRead > 0`.

- [ ] Steps: write → run against the fake (PASS) → **the owner runs `pnpm test:live` by hand
  on the Mac** and pastes the output into the PR; the implementer does not run it in CI.
  Commit `test(contract): the CLI contract suite runs against the fake in CI and the real CLI by hand`.

---

### Task 11: live checks 3–6 (spec section 18), by hand

**Files:**
- Create: `tools/live-checks/run.ts` (guarded by `AGENTOPOLIS_LIVE=1`; each check prints
  `CHECK <n>: <answer>` and the raw evidence path)
- Modify: `docs/superpowers/specs/2026-09-18-agentopolis-v1-design.md` section 18 only, to
  record the answers with the CLI version and date.

Checks (Haiku, `--max-budget-usd 0.05` each, `--bare` never):
3. `--json-schema '{"type":"object","properties":{"word":{"type":"string"}},"required":["word"]}'`
   under `--output-format stream-json`: does the `result` line carry `structured_output`?
4. Hold a `can_use_tool` request for 200 s (env `AGENTOPOLIS_CHECK_HOLD_S`, default 200) before
   answering `allow`: is the answer still accepted (`permission_denials` empty, status `ok`)?
5. `--max-budget-usd 0.0001` with a prompt that needs two tool calls: does the run end with
   `error_max_budget_usd` under the subscription login (`apiKeySource: "none"` in init)?
6. Two runs with the same session: first `--append-system-prompt-file` A (`Rispondi sempre con
   la parola ALPHA`), then `--resume` with file B (`… BETA`) and `--system-prompt-snapshot off`:
   does the second answer say BETA, and is its `cache_creation` small compared to the first?

- [ ] Steps: write the script → **the owner runs it** → the implementer records the answers in
  section 18 (one line each, with `[live 2026-MM-DD, claude x.y.z]`) → commit
  `docs(spec): record live-check answers 3–6`.

---

### Task 12: report and PR

- [ ] Run the full gate: `pnpm test && pnpm typecheck && pnpm lint && pnpm ls --depth 0`.
- [ ] Push `slice/02-engine`, open the PR with the roadmap's report format, including the live
  outputs the owner pasted (test:live and live checks) verbatim, and the SDK API differences
  found in Task 8.
- [ ] Tell the owner the PR number; stop. The supervisor reviews; slice 3 waits for its plan.

## Self-review against the spec (plan author)

- Section 7 argv and env: Task 2 (every flag, `SPAWN_ENV`); `--allowedTools` derived from
  `permissions.allow`; the prompt as first stdin line (Task 7) rather than a positional argument
  so it never touches the shell.
- Section 7 stream handling, failure predicate, MCP `pending` rule, SIGINT/SIGTERM: Tasks 1, 5, 7.
- Section 8 tools and socket: Tasks 8–9. `permission` is not a tool (control channel, Task 7).
- Section 10 tiers 1–2: Task 2 (hook), Task 4 (rules), Task 7 (parked decisions go to
  `events.onPermission`; the store row and the Slack card are slice 4/3).
- Section 13 rows for crash, watchdog, budget, max turns, no-session, MCP failed: Task 7 tests.
- Section 14 fake with pathologies and dual-target contract: Tasks 6, 10.
- Section 18 checks 3–6: Task 11; checks 1–2 are Slack and belong to slice 3.
- Not here by design: retries, the `permission_requests` row, the limit-pause state, session
  rotation and `STATE.md` (slices 4–5).
