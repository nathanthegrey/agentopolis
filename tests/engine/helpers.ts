import { fileURLToPath } from "node:url";
import { loadHome } from "../../src/config/loader.js";
import type { TurnSpec } from "../../src/ports/runner.js";

const home = loadHome(fileURLToPath(new URL("../fixtures/home-valid/", import.meta.url)));
if (!home.ok) throw new Error("home-valid fixture does not load");
export const snapshot = home.snapshot;

export const SESSION = "11111111-1111-4111-8111-111111111111";
export const FAKE = fileURLToPath(
  new URL("../../tools/fake-claude/fake-claude.mjs", import.meta.url),
);
export const FIXTURES = fileURLToPath(
  new URL("../../tools/fake-claude/fixtures/", import.meta.url),
);

export function makeSpec(overrides: Partial<TurnSpec> = {}): TurnSpec {
  const role = snapshot.roles.get("ceo");
  const instance = snapshot.agents.get("ceo");
  if (!role || !instance) throw new Error("fixture lacks ceo");
  return {
    turnId: 1,
    agent: "ceo",
    role,
    instance,
    project: undefined,
    cwd: "/t",
    sessionId: SESSION,
    resume: false,
    systemPromptFile: "/t/system.md",
    prompt: "ciao",
    mcpConfig: {},
    settings: {},
    model: instance.model ?? role.model,
    effort: instance.effort ?? role.effort,
    maxTurns: 60, // spec section 7: a fixed daemon constant, not a role knob
    maxBudgetMicro: 1_000_000,
    wallClockMs: 60_000,
    env: {},
    configVersion: "v",
    ...overrides,
  };
}

/** Polls every 50 ms, up to `timeoutMs`, until `pid` is gone (kill(pid, 0) throws ESRCH). */
export async function expectGone(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return;
      throw e;
    }
    if (Date.now() > deadline) throw new Error(`process ${pid} still alive after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
