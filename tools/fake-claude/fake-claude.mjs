#!/usr/bin/env node
// fake-claude: replays a fixture as if it were `claude -p --output-format stream-json`.
// Invoked with the real CLI's argv. Reads FAKE_CLAUDE_FIXTURE (name) and FAKE_CLAUDE_DIR
// (fixtures folder). Records argv to FAKE_CLAUDE_ARGV_OUT when set.
// Exit codes: 3 unknown option (mirrors the CLI), 4 a control response differed from `expect`,
// 5 fixture problem. Otherwise the fixture's own `exit` step.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGV_OUT) {
  writeFileSync(process.env.FAKE_CLAUDE_ARGV_OUT, JSON.stringify(argv));
}
for (const forbidden of ["--bare", "--continue"]) {
  if (argv.includes(forbidden)) {
    process.stderr.write(`error: unknown option '${forbidden}'\n`);
    process.exit(3);
  }
}
const argValue = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const session = argValue("--session-id") ?? argValue("--resume");
if (!session) {
  process.stderr.write("error: fake-claude needs --session-id or --resume\n");
  process.exit(3);
}

const dir = process.env.FAKE_CLAUDE_DIR;
const name = process.env.FAKE_CLAUDE_FIXTURE;
if (!dir || !name) {
  process.stderr.write("fake-claude: FAKE_CLAUDE_DIR and FAKE_CLAUDE_FIXTURE are required\n");
  process.exit(5);
}
let steps;
try {
  steps = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
} catch (e) {
  process.stderr.write(`fake-claude: cannot read fixture ${name}: ${e.message}\n`);
  process.exit(5);
}

const substitute = (value) => {
  if (typeof value === "string") return value.replaceAll("$SESSION", session);
  if (Array.isArray(value)) return value.map(substitute);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
  }
  return value;
};
const emit = (obj) => process.stdout.write(`${JSON.stringify(substitute(obj))}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// stdin: the first user message and control responses, keyed by request_id
const waiting = new Map();
const responses = new Map();
const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg?.type === "control_response") {
    const id = msg.response?.request_id;
    responses.set(id, msg.response?.response);
    const w = waiting.get(id);
    if (w) {
      waiting.delete(id);
      w(msg.response?.response);
    }
  }
});
const awaitResponse = (id) =>
  responses.has(id)
    ? Promise.resolve(responses.get(id))
    : new Promise((resolve) => waiting.set(id, resolve));

for (const step of steps) {
  if ("emit" in step) emit(step.emit);
  else if ("emit_raw" in step) process.stdout.write(`${step.emit_raw}\n`);
  else if ("stderr" in step) process.stderr.write(`${step.stderr}\n`);
  else if ("sleep" in step) await sleep(step.sleep);
  else if ("spawn_grandchild" in step) {
    const g = spawn("sleep", ["60"], { stdio: "ignore" });
    emit({ type: "fake", grandchild: g.pid });
  } else if ("await_control" in step) {
    emit({ type: "control_request", ...step.await_control });
    const decision = await awaitResponse(step.await_control.request_id);
    if (step.expect && decision?.behavior !== step.expect) {
      process.stderr.write(
        `fake-claude: expected ${step.expect}, got ${JSON.stringify(decision)}\n`,
      );
      process.exit(4);
    }
  } else if ("hang" in step) {
    if (step.hang?.ignore_sigint) process.on("SIGINT", () => {});
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  } else if ("exit" in step) {
    process.exit(step.exit);
  } else {
    process.stderr.write(`fake-claude: unknown step ${JSON.stringify(step)}\n`);
    process.exit(5);
  }
}
process.exit(0);
