// Spec section 18, checks 3–6, against the REAL claude CLI. Run by the owner, by hand:
//   AGENTOPOLIS_LIVE=1 pnpm live:checks                        (all four)
//   AGENTOPOLIS_LIVE=1 AGENTOPOLIS_CHECKS=4 pnpm live:checks   (one check alone)
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

if (process.env.AGENTOPOLIS_LIVE !== "1") {
  console.error(
    "refusing to run: set AGENTOPOLIS_LIVE=1 (this script spends real subscription usage)",
  );
  process.exit(2);
}

const HOLD_S = Number(process.env.AGENTOPOLIS_CHECK_HOLD_S ?? "200");
// AGENTOPOLIS_CHECKS=4 (or "3,6") reruns only those checks; unset = all four
const ONLY = new Set(
  (process.env.AGENTOPOLIS_CHECKS ?? "3,4,5,6")
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
const instance = must(home.snapshot.agents.get("ceo"), "the ceo agent");
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
    model: "haiku",
    effort: undefined,
    maxTurns: 6,
    maxBudgetMicro: o.maxBudgetMicro ?? BUDGET,
    wallClockMs: o.wallClockMs ?? 180_000,
    env: { AGENTOPOLIS_SOCKET: socketPath, AGENTOPOLIS_TOKEN: "live-token" },
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
} finally {
  await socket.close();
}
console.log(`\nall raw streams under ${join(work, "runs")}; paste this output into the PR.`);
