// Spec section 18, checks 3–9, against the REAL claude CLI. Run by the owner, by hand:
//   AGENTOPOLIS_LIVE=1 pnpm live:checks                            (all of them)
//   AGENTOPOLIS_LIVE=1 AGENTOPOLIS_CHECKS=7,8,9 pnpm live:checks   (only these)
// Haiku, --max-budget-usd 0.05 per run, never --bare. Each check prints `CHECK <n>: <answer>`
// and the path of the raw run file that is its evidence. Nothing here runs under `pnpm test`.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initHome } from "../../src/cli/init.js";
import type { Role } from "../../src/config/loader.js";
import { buildMcpConfig } from "../../src/engine/mcp-config.js";
import { composeSystemPrompt } from "../../src/engine/prompt.js";
import { CliRunner, type CliRunnerOptions } from "../../src/engine/runner.js";
import { buildSettings } from "../../src/engine/settings.js";
import { mcpServerCommand } from "../../src/mcp/server-command.js";
import { startToolSocket } from "../../src/mcp/socket-server.js";
import type { ToolHandlers } from "../../src/mcp/tools.js";
import { SystemClock } from "../../src/ports/clock.js";
import { SystemIds } from "../../src/ports/ids.js";
import type { RunnerEvents, TurnOutcome, TurnSpec } from "../../src/ports/runner.js";
import { ENVELOPE_JSON_SCHEMA, parseEnvelope } from "../../src/turn/envelope.js";

/** Long enough that a cache write is worth measuring (check 9). */
const LONG_PROMPT = `Sei un agente di prova.\n${"Questa riga esiste solo per riempire il prompt e rendere misurabile una scrittura di cache.\n".repeat(60)}`;

if (process.env.AGENTOPOLIS_LIVE !== "1") {
  console.error(
    "refusing to run: set AGENTOPOLIS_LIVE=1 (this script spends real subscription usage)",
  );
  process.exit(2);
}

const HOLD_S = Number(process.env.AGENTOPOLIS_CHECK_HOLD_S ?? "200");
// AGENTOPOLIS_CHECKS=4 (or "7,8,9") reruns only those checks; unset = all of them
const ONLY = new Set(
  (process.env.AGENTOPOLIS_CHECKS ?? "3,4,5,6,7,8,9")
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isInteger(n)),
);
const wanted = (n: number) => ONLY.has(n);
const BUDGET = 50_000; // 0.05 USD
const HOOK = fileURLToPath(new URL("../../hooks/pre-tool-use.mjs", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "live-checks-"));
const home = initHome(join(work, "home"));
function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`examples/home lacks ${what}`);
  return v;
}
const ceo = must(home.snapshot.roles.get("ceo"), "the ceo role");
const instance = must(home.snapshot.agents.get("jarvis"), "the ceo agent (jarvis)");
// the checks need Bash: a copy of the ceo role with nothing stripped and no allow rules
const bashRole: Role = {
  ...ceo,
  disallowed_tools: [],
  permissions: { mode: "default", allow: [], deny: [], hooks: [] },
};
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
  tokens: new Map([["live-token", { agent: "ceo", turnId: 0 }]]),
  handlers,
});
const ids = new SystemIds();
let turn = 0;

function spec(o: {
  role: Role;
  sessionId: string;
  resume: boolean;
  prompt: string;
  systemPrompt: string;
  maxBudgetMicro?: number;
  wallClockMs?: number;
  model?: string;
  effort?: string;
  extraArgs?: string[];
}): TurnSpec {
  turn += 1;
  const systemPromptFile = join(work, `system-${turn}.md`);
  writeFileSync(systemPromptFile, o.systemPrompt);
  return {
    turnId: turn,
    agent: "ceo",
    role: o.role,
    instance,
    project: undefined,
    cwd: work,
    sessionId: o.sessionId,
    resume: o.resume,
    systemPromptFile,
    prompt: o.prompt,
    mcpConfig: JSON.parse(buildMcpConfig(o.role, {}, mcpServerCommand())),
    settings: buildSettings(o.role, undefined, HOOK),
    model: o.model ?? "haiku",
    effort: o.effort,
    maxTurns: 6,
    maxBudgetMicro: o.maxBudgetMicro ?? BUDGET,
    wallClockMs: o.wallClockMs ?? 180_000,
    env: { AGENTOPOLIS_SOCKET: socketPath, AGENTOPOLIS_TOKEN: "live-token" },
    extraArgs: o.extraArgs ?? [],
    configVersion: home.snapshot.version,
  };
}

const runner = (extra: Partial<CliRunnerOptions> = {}) =>
  new CliRunner({
    claudePath: "claude",
    runsDir: join(work, "runs"),
    clock: new SystemClock(),
    ...extra,
  });
const allow: RunnerEvents = { onPermission: async () => ({ behavior: "allow" }) };
const resultLine = (o: TurnOutcome): Record<string, unknown> | undefined =>
  readFileSync(o.runFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((l) => l.type === "result");
const initLine = (o: TurnOutcome): Record<string, unknown> | undefined =>
  readFileSync(o.runFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((l) => l.type === "system" && l.subtype === "init");
const report = (n: number, answer: string, o: TurnOutcome) =>
  console.log(
    `CHECK ${n}: ${answer}\n  evidence: ${o.runFile}\n  status=${o.status} cost=${o.costMicro} error=${o.error ?? "-"}`,
  );

try {
  // 3. structured_output under stream-json with --json-schema
  if (wanted(3)) {
    const schema = '{"type":"object","properties":{"word":{"type":"string"}},"required":["word"]}';
    const o = await runner({ extraArgs: ["--json-schema", schema] }).run(
      spec({
        role: ceo,
        sessionId: ids.uuid(),
        resume: false,
        prompt: "Rispondi con la parola ok",
        systemPrompt: composeSystemPrompt(home.snapshot.style, ceo),
      }),
      allow,
    );
    const r = resultLine(o);
    const has = r !== undefined && "structured_output" in r;
    report(
      3,
      `result line ${has ? "CARRIES" : "does NOT carry"} structured_output${has ? `: ${JSON.stringify(r?.structured_output)}` : ""}`,
      o,
    );
  }

  // 4. a can_use_tool request held for HOLD_S seconds, then allowed.
  // The command must WRITE: a read-only command such as `echo` is auto-approved by the CLI
  // and never reaches the control channel (first live run, 2026-09-18).
  if (wanted(4)) {
    const started = Date.now();
    const check4File = join(work, "check4.txt");
    let held = 0;
    const events: RunnerEvents = {
      onPermission: async (req) => {
        held += 1;
        console.log(`  holding ${req.toolName} (${req.toolUseId}) for ${HOLD_S} s …`);
        await new Promise((r) => setTimeout(r, HOLD_S * 1000));
        return { behavior: "allow" };
      },
    };
    const o = await runner().run(
      spec({
        role: bashRole,
        sessionId: ids.uuid(),
        resume: false,
        prompt: `Esegui con lo strumento Bash esattamente questo comando: printf ciao-dal-check-4 > ${check4File} && cat ${check4File} . Poi riferisci l'output esatto.`,
        systemPrompt: "Rispondi in una riga.",
        wallClockMs: (HOLD_S + 120) * 1000,
      }),
      events,
    );
    const written = existsSync(check4File);
    const answered = held > 0 && o.status === "ok" && o.permissionDenials.length === 0 && written;
    const verdict =
      held === 0
        ? "INCONCLUSIVE: no can_use_tool request was emitted"
        : answered
          ? "answer ACCEPTED (file written after the hold)"
          : "answer NOT accepted";
    report(
      4,
      `${held} request(s) held ${HOLD_S} s; ${verdict}; file written=${written}; denials=${JSON.stringify(o.permissionDenials)}; took ${Math.round((Date.now() - started) / 1000)} s; text=${JSON.stringify(o.resultText)}`,
      o,
    );
  }

  // 5. --max-budget-usd 0.0001 on a two-tool-call prompt, under the subscription login
  if (wanted(5)) {
    const o = await runner().run(
      spec({
        role: bashRole,
        sessionId: ids.uuid(),
        resume: false,
        prompt:
          "Esegui con Bash `echo uno`, poi in una seconda chiamata separata `echo due`, e riferisci entrambi gli output.",
        systemPrompt: "Rispondi in una riga.",
        maxBudgetMicro: 100,
      }),
      allow,
    );
    const init = initLine(o);
    report(
      5,
      `status=${o.status} subtype=${String(resultLine(o)?.subtype)} apiKeySource=${String(init?.apiKeySource)} cost=${o.costMicro}`,
      o,
    );
  }

  // 6. system prompt rebuilt on --resume with --system-prompt-snapshot off
  if (wanted(6)) {
    const sessionId = ids.uuid();
    const a = await runner().run(
      spec({
        role: ceo,
        sessionId,
        resume: false,
        prompt: "Come ti chiami?",
        systemPrompt: "Rispondi sempre e solo con la parola ALPHA.",
      }),
      allow,
    );
    const b = await runner().run(
      spec({
        role: ceo,
        sessionId,
        resume: true,
        prompt: "E adesso?",
        systemPrompt: "Rispondi sempre e solo con la parola BETA.",
      }),
      allow,
    );
    const saysBeta = (b.resultText ?? "").toUpperCase().includes("BETA");
    report(
      6,
      `second answer ${saysBeta ? "says BETA" : "does NOT say BETA"} (${JSON.stringify(b.resultText)}); cache_creation first=${a.cacheCreation} second=${b.cacheCreation}; cache_read second=${b.cacheRead}`,
      b,
    );
    console.log(`  first run evidence: ${a.runFile}`);
  }
  // 7. does a tool-heavy turn still return a valid envelope on the first try, and how often
  //    does the CLI's structured-output retry fire? (spec section 18, pending → slice 4)
  if (wanted(7)) {
    const schema = JSON.stringify(ENVELOPE_JSON_SCHEMA);
    const o = await runner().run(
      spec({
        role: bashRole,
        sessionId: ids.uuid(),
        resume: false,
        extraArgs: ["--json-schema", schema],
        prompt: [
          "Esegui `echo uno`, poi `echo due`, poi `ls`.",
          'Poi rispondi con la busta: un solo messaggio, container "dm:ceo", to "owner",',
          'kind "say", body una riga che dice cosa hai eseguito.',
        ].join(" "),
        systemPrompt: "Sei un agente di prova. Usa Bash quando te lo chiedono.",
        maxBudgetMicro: 200_000,
      }),
      allow,
    );
    const result = resultLine(o);
    const parsed = parseEnvelope(o.structuredOutput);
    const raw = readFileSync(o.runFile, "utf8").split("\n").filter(Boolean);
    const toolCalls = raw.filter((l) => l.includes('"tool_use"')).length;
    report(
      7,
      `schema ${schema.length} chars; tool_use lines=${toolCalls}; subtype=${String(result?.subtype)}; ` +
        `envelope ${parsed.ok ? "VALID on the first try" : `INVALID: ${parsed.error}`}; ` +
        `structured_output=${JSON.stringify(o.structuredOutput)}`,
      o,
    );
  }

  // 8. Fable under the subscription, and the research subagent's model per spawn (A9)
  if (wanted(8)) {
    const fable = await runner().run(
      spec({
        role: ceo,
        sessionId: ids.uuid(),
        resume: false,
        model: "fable",
        prompt: "Rispondi con una sola parola: ok.",
        systemPrompt: "Rispondi con una sola parola.",
      }),
      allow,
    );
    const init = initLine(fable);
    report(
      8,
      `(a) model in system/init = ${String(init?.model)}, apiKeySource=${String(init?.apiKeySource)}; ` +
        `(b) cost=${fable.costMicro} micro-USD, costBasis=${fable.costBasis}, ` +
        `modelUsage=${JSON.stringify(fable.modelUsage)}`,
      fable,
    );

    // (c) a --agents JSON naming opus on research, honoured per spawn
    const agents = JSON.stringify({
      research: {
        description: "Read-only research.",
        prompt: "Answer in one word: pronto.",
        model: "opus",
      },
    });
    const sub = await runner().run(
      spec({
        role: bashRole,
        sessionId: ids.uuid(),
        resume: false,
        extraArgs: ["--agents", agents],
        prompt: "Usa il subagente research per rispondere in una parola.",
        systemPrompt: "Delega al subagente research quando te lo chiedono.",
        maxBudgetMicro: 200_000,
      }),
      allow,
    );
    report(
      8,
      `(c) --agents accepted; modelUsage=${JSON.stringify(sub.modelUsage)} ` +
        "(look for an opus entry: that is the subagent's own spawn)",
      sub,
    );
    console.log(
      "  (d) ANSWERED WITHOUT A TURN: `maxEffortLevel` exists in the installed 2.1.277 bundle,\n" +
        '      described as "Maximum effort level. Anything above it (an /effort or /model pick,\n' +
        '      --effort, CLAUDE_CODE_EFFORT_LEVEL, a model default) ... Enforced client-side";\n' +
        '      the daemon now passes maxEffortLevel: "high" in --settings (src/engine/settings.ts).',
    );
  }

  // 9. what a 1 h cache write costs against a 5 m one, on the subscription
  if (wanted(9)) {
    const twoTurns = async (ttl: string) => {
      const sessionId = ids.uuid();
      // SPAWN_ENV pins the TTL at 1h, so the override has to come after it
      const ttlRunner = () => runner({ envOverride: { CLAUDE_CODE_PROMPT_CACHE_TTL: ttl } });
      const first = await ttlRunner().run(
        spec({
          role: ceo,
          sessionId,
          resume: false,
          prompt: "Rispondi con una sola parola: uno.",
          systemPrompt: LONG_PROMPT,
        }),
        allow,
      );
      const second = await ttlRunner().run(
        spec({
          role: ceo,
          sessionId,
          resume: true,
          prompt: "Rispondi con una sola parola: due.",
          systemPrompt: LONG_PROMPT,
        }),
        allow,
      );
      return { first, second };
    };
    const short = await twoTurns("5m");
    const long = await twoTurns("1h");
    report(
      9,
      `5m: write=${short.first.cacheCreation} read2=${short.second.cacheRead} cost1=${short.first.costMicro} cost2=${short.second.costMicro}; ` +
        `1h: write=${long.first.cacheCreation} read2=${long.second.cacheRead} cost1=${long.first.costMicro} cost2=${long.second.costMicro}`,
      long.second,
    );
    console.log(`  5m evidence: ${short.first.runFile} and ${short.second.runFile}`);
  }
} finally {
  await socket.close();
}
console.log(`\nall raw streams under ${join(work, "runs")}; paste this output into the PR.`);
