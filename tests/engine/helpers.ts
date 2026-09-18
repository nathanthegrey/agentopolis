import { fileURLToPath } from "node:url";
import { loadHome } from "../../src/config/loader.js";
import type { TurnSpec } from "../../src/ports/runner.js";

const home = loadHome(fileURLToPath(new URL("../fixtures/home-valid/", import.meta.url)));
if (!home.ok) throw new Error("home-valid fixture does not load");
export const snapshot = home.snapshot;

export const SESSION = "11111111-1111-4111-8111-111111111111";

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
    maxTurns: role.max_turns,
    maxBudgetMicro: 1_000_000,
    wallClockMs: 60_000,
    env: {},
    configVersion: "v",
    ...overrides,
  };
}
