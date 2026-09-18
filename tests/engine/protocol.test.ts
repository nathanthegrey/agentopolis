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
  it("parses an api_retry system line", () => {
    const m = parseLine(
      '{"type":"system","subtype":"api_retry","error":"rate_limit","error_status":429,"attempt":2}',
    );
    expect(m.type).toBe("api_retry");
    if (m.type !== "api_retry") return;
    expect(m.error).toBe("rate_limit");
    expect(m.attempt).toBe(2);
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
    expect(o.sessionId).toBe("s1");
  });
  it("maps result subtypes to statuses", () => {
    for (const [sub, status] of [
      ["error_max_turns", "max_turns"],
      ["error_max_budget_usd", "budget_exhausted"],
      ["error_during_execution", "failed"],
    ] as const) {
      const m = parseLine(result.replace('"subtype":"success"', `"subtype":"${sub}"`));
      if (m.type !== "result") throw new Error("not a result");
      expect(outcomeFromResult(m).status).toBe(status);
    }
  });
  it("keeps unknown types and broken lines without throwing", () => {
    expect(parseLine('{"type":"something_new","x":1}').type).toBe("unknown");
    expect(parseLine("{not json").type).toBe("unparseable");
    expect(parseLine("").type).toBe("unparseable");
    expect(parseLine("[1,2]").type).toBe("unknown");
  });
  it("a result without costs yields null money, never zero", () => {
    const m = parseLine(
      '{"type":"result","subtype":"error_during_execution","session_id":"s1","is_error":true}',
    );
    if (m.type !== "result") throw new Error("not a result");
    const o = outcomeFromResult(m);
    expect(o.costMicro).toBeNull();
    expect(o.costBasis).toBeNull();
    expect(o.cacheRead).toBeNull();
  });
});
