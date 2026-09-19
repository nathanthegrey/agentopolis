import type { Role } from "../config/loader.js";
import type { AgentFile, ProjectFile } from "../config/schemas.js";

export type TurnSpec = {
  turnId: number;
  agent: string;
  role: Role;
  instance: AgentFile;
  project: ProjectFile | undefined;
  cwd: string;
  sessionId: string; // allocated by the daemon before spawn
  resume: boolean; // false on the session's first turn
  systemPromptFile: string; // path written by the caller (prompt.ts)
  prompt: string; // the turn's user message (new messages, outcomes, memory lines)
  mcpConfig: Record<string, unknown>;
  settings: Record<string, unknown>;
  model: string;
  effort: string | undefined;
  maxTurns: number;
  maxBudgetMicro: number;
  wallClockMs: number;
  env: Record<string, string>; // AGENTOPOLIS_* for the MCP server, plus spec section 7 env
  /** flags built per turn and appended last: --agents and --json-schema (spec sections 6, 7) */
  extraArgs: string[];
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
  | "ok"
  | "failed"
  | "interrupted"
  | "timed_out"
  | "cancelled"
  | "budget_exhausted"
  | "max_turns";

export type TurnOutcome = {
  status: TurnStatus;
  sessionId: string;
  resultText: string | undefined;
  /** the result's structured_output: the envelope, when --json-schema was passed */
  structuredOutput: unknown;
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
  runFile: string; // runs/<turnId>.ndjson
};

export interface RunnerEvents {
  onPermission(req: PermissionRequest): Promise<PermissionDecision>;
  onRateLimit?(info: RateLimitInfo): void;
  onActivity?(kind: "assistant" | "tool_use" | "tool_result"): void;
}

export interface AgentRunner {
  run(spec: TurnSpec, events: RunnerEvents): Promise<TurnOutcome>;
}
