import { describe, expect, it } from "vitest";
import { buildMcpConfig } from "../../src/engine/mcp-config.js";
import { buildSettings } from "../../src/engine/settings.js";
import { snapshot } from "./helpers.js";

const ceo = () => {
  const r = snapshot.roles.get("ceo");
  if (!r) throw new Error("fixture");
  return r;
};

describe("buildMcpConfig", () => {
  it("is byte-stable: same inputs, same string, keys sorted, agentopolis alwaysLoad", () => {
    const role = { ...ceo(), tools: ["github", "agentopolis"] };
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
    const role = { ...ceo(), tools: ["agentopolis", "ghost"] };
    expect(() => buildMcpConfig(role, {}, { command: "node", args: [] })).toThrow(/ghost/);
  });
});

describe("buildSettings", () => {
  it("carries allow/deny and adds the PreToolUse hook only when the role asks for it", () => {
    const base = ceo();
    const plain = buildSettings(base, ["master"], "/h/pre-tool-use.mjs");
    expect(plain).toEqual({ permissions: { allow: [], deny: [] } });
    const hooked = buildSettings(
      { ...base, permissions: { ...base.permissions, hooks: ["deny_push_to_production"] } },
      ["master", "main"],
      "/h/pre-tool-use.mjs",
    );
    const hooks = hooked.hooks as {
      PreToolUse: {
        matcher: string;
        hooks: { type: string; command: string; timeout: number }[];
      }[];
    };
    expect(hooks.PreToolUse[0]?.matcher).toBe("Bash");
    expect(hooks.PreToolUse[0]?.hooks[0]?.command).toContain(
      "AGENTOPOLIS_PRODUCTION_BRANCHES=master,main",
    );
    expect(hooks.PreToolUse[0]?.hooks[0]?.command).toContain("/h/pre-tool-use.mjs");
  });
  it("adds no hook when there is no production branch to protect", () => {
    const base = ceo();
    const s = buildSettings(
      { ...base, permissions: { ...base.permissions, hooks: ["deny_push_to_production"] } },
      undefined,
      "/h/x.mjs",
    );
    expect(s.hooks).toBeUndefined();
  });
});
