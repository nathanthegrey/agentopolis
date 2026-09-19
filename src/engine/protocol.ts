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
    unifiedWindows: z
      .record(
        z.string(),
        z.looseObject({ utilization: z.number(), resetsAt: z.number().optional() }),
      )
      .optional(),
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
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })
    .optional(),
  modelUsage: z.record(z.string(), z.looseObject({ costBasis: z.string().optional() })).optional(),
  permission_denials: z.array(z.unknown()).optional(),
});
export type ResultRaw = z.infer<typeof Result>;

export type StreamMessage =
  | {
      type: "system_init";
      sessionId: string;
      model: string | undefined;
      tools: string[];
      mcpServers: Record<string, string>;
      apiKeySource: string | undefined;
      raw: unknown;
    }
  | { type: "rate_limit"; info: RateLimitInfo; raw: unknown }
  | { type: "permission_request"; request: PermissionRequest; raw: unknown }
  | { type: "control_request_other"; requestId: string; subtype: string; raw: unknown }
  | {
      type: "api_retry";
      error: string | undefined;
      status: number | null | undefined;
      attempt: number | undefined;
      raw: unknown;
    }
  | { type: "assistant"; raw: unknown }
  | { type: "user"; raw: unknown }
  | { type: "result"; subtype: string; raw: ResultRaw }
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
  const t = (raw as { type?: unknown }).type;
  if (t === "system") {
    const i = Init.safeParse(raw);
    if (i.success) {
      const mcpServers: Record<string, string> = {};
      for (const s of i.data.mcp_servers ?? []) mcpServers[s.name] = s.status;
      return {
        type: "system_init",
        sessionId: i.data.session_id,
        model: i.data.model,
        tools: i.data.tools ?? [],
        mcpServers,
        apiKeySource: i.data.apiKeySource,
        raw,
      };
    }
    const r = ApiRetry.safeParse(raw);
    if (r.success) {
      return {
        type: "api_retry",
        error: r.data.error,
        status: r.data.error_status,
        attempt: r.data.attempt,
        raw,
      };
    }
    return { type: "unknown", raw };
  }
  if (t === "rate_limit_event") {
    const p = RateLimit.safeParse(raw);
    if (!p.success) return { type: "unknown", raw };
    const windows: RateLimitInfo["windows"] = {};
    for (const [k, v] of Object.entries(p.data.rate_limit_info.unifiedWindows ?? {})) {
      windows[k] = { utilization: v.utilization, resetsAt: v.resetsAt };
    }
    return {
      type: "rate_limit",
      info: {
        status: p.data.rate_limit_info.status,
        resetsAt: p.data.rate_limit_info.resetsAt,
        windows,
      },
      raw,
    };
  }
  if (t === "control_request") {
    const p = ControlRequest.safeParse(raw);
    if (!p.success) return { type: "unknown", raw };
    const req = p.data.request;
    if (req.subtype === "can_use_tool" && req.tool_name && req.tool_use_id) {
      return {
        type: "permission_request",
        request: {
          requestId: p.data.request_id,
          toolUseId: req.tool_use_id,
          toolName: req.tool_name,
          input: req.input,
          suggestions: req.permission_suggestions,
        },
        raw,
      };
    }
    return {
      type: "control_request_other",
      requestId: p.data.request_id,
      subtype: req.subtype,
      raw,
    };
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

export function outcomeFromResult(
  m: Extract<StreamMessage, { type: "result" }>,
): Partial<TurnOutcome> {
  const r = m.raw;
  const basisValues = Object.values(r.modelUsage ?? {}).map((u) => u.costBasis);
  const known = basisValues.find((b) => b === "list" || b === "managed");
  const costBasis: TurnOutcome["costBasis"] =
    known === "list" || known === "managed" ? known : basisValues.length ? "unknown" : null;
  return {
    status: STATUS[r.subtype] ?? "failed",
    resultText: r.result,
    structuredOutput: r.structured_output,
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
