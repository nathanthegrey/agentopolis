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

/** integer micro-USD → decimal string without float artefacts */
export function usdString(micro: number): string {
  const whole = Math.floor(micro / 1_000_000);
  const frac = String(micro % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

export function buildArgv(
  spec: TurnSpec,
  paths: { mcpConfigFile: string; settingsJson: string },
): string[] {
  const argv = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
  ];
  argv.push(spec.resume ? "--resume" : "--session-id", spec.sessionId);
  argv.push("--model", spec.model);
  if (spec.effort) argv.push("--effort", spec.effort);
  argv.push(
    "--max-turns",
    String(spec.maxTurns),
    "--max-budget-usd",
    usdString(spec.maxBudgetMicro),
  );
  argv.push("--permission-mode", spec.role.permissions.mode);
  if (spec.role.permissions.allow.length) {
    argv.push("--allowedTools", spec.role.permissions.allow.join(","));
  }
  if (spec.role.disallowed_tools.length) {
    argv.push("--disallowedTools", spec.role.disallowed_tools.join(","));
  }
  argv.push("--permission-prompt-tool", "stdio", "--permission-prompts", "host");
  argv.push("--setting-sources", "", "--settings", paths.settingsJson);
  argv.push("--mcp-config", paths.mcpConfigFile, "--strict-mcp-config");
  argv.push("--append-system-prompt-file", spec.systemPromptFile);
  argv.push("--system-prompt-snapshot", "off", "--exclude-dynamic-system-prompt-sections");
  argv.push("--name", spec.agent);
  argv.push(...spec.extraArgs);
  return argv;
}
