import { describe, expect, it } from "vitest";
import { buildArgv, SPAWN_ENV, usdString } from "../../src/engine/argv.js";
import { makeSpec } from "./helpers.js";

const paths = { mcpConfigFile: "/t/mcp.json", settingsJson: "{}" };

describe("buildArgv", () => {
  it("builds the exact argument list for a first turn", () => {
    const argv = buildArgv(makeSpec({ resume: false }), paths);
    expect(argv).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--session-id",
      "11111111-1111-4111-8111-111111111111",
      "--model",
      "sonnet",
      "--effort",
      "low",
      "--max-turns",
      "20",
      "--max-budget-usd",
      "1",
      "--permission-mode",
      "default",
      "--disallowedTools",
      "Edit,Write,NotebookEdit,Bash",
      "--permission-prompt-tool",
      "stdio",
      "--permission-prompts",
      "host",
      "--setting-sources",
      "",
      "--settings",
      "{}",
      "--mcp-config",
      "/t/mcp.json",
      "--strict-mcp-config",
      "--append-system-prompt-file",
      "/t/system.md",
      "--system-prompt-snapshot",
      "off",
      "--exclude-dynamic-system-prompt-sections",
      "--name",
      "ceo",
    ]);
  });
  it("uses --resume on later turns and omits --effort when unset", () => {
    const argv = buildArgv(makeSpec({ resume: true, effort: undefined }), paths);
    expect(argv).toContain("--resume");
    expect(argv).not.toContain("--session-id");
    expect(argv).not.toContain("--effort");
  });
  it("emits --allowedTools from the role's allow list", () => {
    const spec = makeSpec();
    const role = {
      ...spec.role,
      permissions: { ...spec.role.permissions, allow: ["Read", "Bash(git *)"] },
    };
    const argv = buildArgv({ ...spec, role }, paths);
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("Read,Bash(git *)");
  });
  it("never emits --bare or --continue, and formats the budget without float noise", () => {
    const argv = buildArgv(makeSpec({ maxBudgetMicro: 123_456 }), paths);
    expect(argv).not.toContain("--bare");
    expect(argv).not.toContain("--continue");
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("0.123456");
    expect(usdString(50_000)).toBe("0.05");
    expect(usdString(2_500_000)).toBe("2.5");
    expect(usdString(0)).toBe("0");
  });
  it("pins the cache and compaction environment", () => {
    expect(SPAWN_ENV.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("1h");
    expect(SPAWN_ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("100000");
    expect(SPAWN_ENV.CLAUDE_CODE_STARTUP_FAILURE_RESULTS).toBe("1");
    expect(SPAWN_ENV.MCP_TIMEOUT).toBe("5000");
  });
});
