import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../ports/clock.js";
import type {
  AgentRunner,
  PermissionDecision,
  RunnerEvents,
  TurnOutcome,
  TurnSpec,
  TurnStatus,
} from "../ports/runner.js";
import { buildArgv, SPAWN_ENV } from "./argv.js";
import { spawnLines } from "./process.js";
import { outcomeFromResult, parseLine } from "./protocol.js";

export type CliRunnerOptions = {
  claudePath: string;
  /** arguments placed before the CLI's own (e.g. `[fake-claude.mjs]` when claudePath is `node`) */
  claudeArgs?: string[];
  runsDir: string;
  clock: Clock;
  /** SIGINT → this long → SIGKILL, for the watchdog and MCP failures (spec 7: 10 s) */
  stopGraceMs?: number;
};

const STDERR_TAIL = 2_000;
const DEFAULT_STOP_GRACE_MS = 10_000;

/** Runs one agent turn as one CLI process. No retries, no sleeps except the watchdog. */
export class CliRunner implements AgentRunner {
  readonly #opts: CliRunnerOptions;

  constructor(opts: CliRunnerOptions) {
    this.#opts = opts;
  }

  async run(spec: TurnSpec, events: RunnerEvents): Promise<TurnOutcome> {
    const { runsDir } = this.#opts;
    mkdirSync(runsDir, { recursive: true });
    const mcpConfigFile = join(runsDir, `${spec.turnId}.mcp.json`);
    const runFile = join(runsDir, `${spec.turnId}.ndjson`);
    writeFileSync(mcpConfigFile, JSON.stringify(spec.mcpConfig));
    const argv = buildArgv(spec, { mcpConfigFile, settingsJson: JSON.stringify(spec.settings) });

    const outcome: TurnOutcome = {
      status: "failed",
      sessionId: spec.sessionId,
      resultText: undefined,
      costMicro: null,
      costBasis: null,
      modelUsage: null,
      cacheRead: null,
      cacheCreation: null,
      inputTokens: null,
      permissionDenials: [],
      rateLimit: undefined,
      mcpStatus: {},
      exitCode: null,
      signal: null,
      error: undefined,
      runFile,
    };
    let resultSeen = false;
    let forcedStatus: TurnStatus | undefined; // set by the watchdog or an MCP failure
    let stderr = "";
    let lastApiRetry: string | undefined;
    let unparseable = 0;
    let queue: Promise<void> = Promise.resolve();

    const child = spawnLines(this.#opts.claudePath, [...(this.#opts.claudeArgs ?? []), ...argv], {
      cwd: spec.cwd,
      env: { ...process.env, ...SPAWN_ENV, ...spec.env } as Record<string, string>,
      teeTo: runFile,
      onStderr: (chunk) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL);
      },
      onLine: (line) => {
        queue = queue.then(() => handle(line));
      },
    });

    const stopWith = (status: TurnStatus, error: string) => {
      if (forcedStatus) return;
      forcedStatus = status;
      outcome.error = error;
      void child.stop(this.#opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
    };

    const handle = async (line: string): Promise<void> => {
      const m = parseLine(line);
      switch (m.type) {
        case "rate_limit":
          outcome.rateLimit = m.info;
          events.onRateLimit?.(m.info);
          return;
        case "system_init": {
          outcome.mcpStatus = m.mcpServers;
          const s = m.mcpServers.agentopolis;
          if (s === "failed" || s === "needs-auth") {
            stopWith("failed", `agentopolis MCP server ${s}`);
          }
          return;
        }
        case "permission_request": {
          let decision: PermissionDecision;
          try {
            decision = await events.onPermission(m.request);
          } catch (e) {
            decision = {
              behavior: "deny",
              message: `permission handler failed: ${(e as Error).message}`,
            };
          }
          child.writeLine({
            type: "control_response",
            response: { subtype: "success", request_id: m.request.requestId, response: decision },
          });
          return;
        }
        case "assistant":
          events.onActivity?.("assistant");
          return;
        case "user":
          events.onActivity?.("tool_result");
          return;
        case "api_retry":
          lastApiRetry = `api_retry: ${m.error ?? "unknown"}${m.status ? ` (${m.status})` : ""}`;
          return;
        case "result": {
          resultSeen = true;
          Object.assign(outcome, outcomeFromResult(m));
          // no control request can follow the result: the channel may close now
          child.endInput();
          return;
        }
        case "unparseable":
          unparseable += 1;
          return;
        default:
          return;
      }
    };

    // The prompt is the first stdin line; stdin stays open because control responses
    // (permission decisions) travel on it until the result line arrives.
    child.writeLine({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: spec.prompt }] },
    });

    const watchdog = setTimeout(
      () => stopWith("timed_out", `wall clock of ${spec.wallClockMs} ms exceeded`),
      spec.wallClockMs,
    );
    const { code, signal } = await child.closed;
    clearTimeout(watchdog);
    await queue;

    outcome.exitCode = code;
    outcome.signal = signal;
    if (forcedStatus) {
      outcome.status = forcedStatus;
      outcome.costMicro = null;
    } else if (!resultSeen) {
      outcome.status = "failed";
      outcome.costMicro = null;
      outcome.error = stderr.trim() || lastApiRetry || "exited without result";
    } else if (outcome.status !== "ok" && outcome.error === undefined) {
      outcome.error = stderr.trim() || lastApiRetry || `result status ${outcome.status}`;
    }
    if (unparseable > 0 && outcome.error === undefined && outcome.status !== "ok") {
      outcome.error = `${unparseable} unparseable line(s)`;
    }
    return outcome;
  }
}
