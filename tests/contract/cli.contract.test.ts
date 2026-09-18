// Dual-target contract suite. Default: fake-claude (CI). AGENTOPOLIS_LIVE=1: the real CLI,
// Haiku, --max-budget-usd 0.05, by hand on the owner's Mac (`pnpm test:live`). The same
// assertions hold on both targets so the fake cannot drift from reality unnoticed.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initHome } from "../../src/cli/init.js";
import { buildMcpConfig } from "../../src/engine/mcp-config.js";
import { composeSystemPrompt } from "../../src/engine/prompt.js";
import { CliRunner } from "../../src/engine/runner.js";
import { buildSettings } from "../../src/engine/settings.js";
import { mcpServerCommand } from "../../src/mcp/server-command.js";
import { startToolSocket } from "../../src/mcp/socket-server.js";
import type { ToolHandlers } from "../../src/mcp/tools.js";
import { SystemClock } from "../../src/ports/clock.js";
import type { TurnOutcome, TurnSpec } from "../../src/ports/runner.js";
import { FAKE, FIXTURES } from "../engine/helpers.js";

const LIVE = process.env.AGENTOPOLIS_LIVE === "1";
const SESSION = "22222222-2222-4222-8222-222222222222";
const HOOK = fileURLToPath(new URL("../../hooks/pre-tool-use.mjs", import.meta.url));

async function scenario() {
  const work = mkdtempSync(join(tmpdir(), "contract-"));
  const home = initHome(join(work, "home"));
  const role = home.snapshot.roles.get("ceo");
  const instance = home.snapshot.agents.get("ceo");
  if (!role || !instance) throw new Error("examples/home lacks the ceo");
  const systemPromptFile = join(work, "system.md");
  writeFileSync(systemPromptFile, composeSystemPrompt(home.snapshot.style, role));
  const socketPath = join(work, "d.sock");
  const noop = async () => null;
  const handlers: ToolHandlers = {
    post: noop,
    answer: noop,
    read_channel: async () => [],
    request: noop,
    remember: noop,
    status: async () => ({ budget_left_usd: "0.05", open_asks: 0 }),
  };
  const socket = await startToolSocket({
    path: socketPath,
    tokens: new Map([["contract-token", { agent: "ceo", turnId: 1 }]]),
    handlers,
  });
  const runsDir = join(work, "runs");
  const runner = LIVE
    ? new CliRunner({ claudePath: "claude", runsDir, clock: new SystemClock() })
    : new CliRunner({
        claudePath: "node",
        claudeArgs: [FAKE],
        runsDir,
        clock: new SystemClock(),
        stopGraceMs: 500,
      });
  const spec = (turnId: number, resume: boolean): TurnSpec => ({
    turnId,
    agent: "ceo",
    role,
    instance,
    project: undefined,
    cwd: work,
    sessionId: SESSION,
    resume,
    systemPromptFile,
    prompt: "Rispondi con la sola parola: ok",
    mcpConfig: JSON.parse(buildMcpConfig(role, {}, mcpServerCommand())),
    settings: buildSettings(role, undefined, HOOK),
    model: LIVE ? "haiku" : role.model,
    effort: undefined,
    maxTurns: 2,
    maxBudgetMicro: 50_000,
    wallClockMs: 120_000,
    env: {
      AGENTOPOLIS_SOCKET: socketPath,
      AGENTOPOLIS_TOKEN: "contract-token",
      ...(LIVE ? {} : { FAKE_CLAUDE_DIR: FIXTURES, FAKE_CLAUDE_FIXTURE: "contract-happy" }),
    },
    configVersion: home.snapshot.version,
  });
  return { runner, spec, socket, work };
}

const lines = (o: TurnOutcome) =>
  readFileSync(o.runFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type?: string; subtype?: string });

describe(`CLI contract (${LIVE ? "LIVE claude" : "fake-claude"})`, () => {
  it("a first turn answers, records its session and cost shape, and writes the run file", async () => {
    const s = await scenario();
    try {
      const o = await s.runner.run(s.spec(1, false), {
        onPermission: async () => ({ behavior: "allow" }),
      });
      expect(o.status).toBe("ok");
      expect((o.resultText ?? "").toLowerCase()).toContain("ok");
      expect(o.sessionId).toBe(SESSION);
      expect(o.costMicro === null || (Number.isInteger(o.costMicro) && o.costMicro >= 0)).toBe(
        true,
      );
      const ls = lines(o);
      expect(ls.some((l) => l.type === "system" && l.subtype === "init")).toBe(true);
      expect(ls.some((l) => l.type === "result")).toBe(true);
      expect(["connected", "pending"]).toContain(o.mcpStatus.agentopolis);
      if (LIVE) {
        const again = await s.runner.run(s.spec(2, true), {
          onPermission: async () => ({ behavior: "allow" }),
        });
        expect(again.status).toBe("ok");
        expect(again.cacheRead ?? 0).toBeGreaterThan(0);
      }
    } finally {
      await s.socket.close();
    }
  }, 180_000);
});
