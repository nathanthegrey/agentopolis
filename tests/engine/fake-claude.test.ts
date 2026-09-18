import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnLines } from "../../src/engine/process.js";
import { FAKE, FIXTURES } from "./helpers.js";

const SESSION = "11111111-1111-4111-8111-111111111111";

function start(fixture: string, argv: string[], extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fake-"));
  const lines: string[] = [];
  let stderr = "";
  const h = spawnLines("node", [FAKE, ...argv], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      FAKE_CLAUDE_DIR: FIXTURES,
      FAKE_CLAUDE_FIXTURE: fixture,
      ...extraEnv,
    },
    onLine: (l) => lines.push(l),
    onStderr: (c) => {
      stderr += c;
    },
    teeTo: join(dir, "run.ndjson"),
  });
  return { h, lines, stderr: () => stderr, dir };
}
const parsed = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe("fake-claude", () => {
  it("replays a fixture in order and substitutes $SESSION", async () => {
    const f = start("happy", ["-p", "--session-id", SESSION]);
    f.h.endInput();
    const r = await f.h.closed;
    expect(r.code).toBe(0);
    const types = parsed(f.lines).map((m) => m.type);
    expect(types).toEqual(["rate_limit_event", "system", "assistant", "result"]);
    const init = parsed(f.lines)[1] as { session_id: string };
    expect(init.session_id).toBe(SESSION);
  });

  it("blocks on await_control until a control_response arrives, and honours expect", async () => {
    const f = start("permission-parked", ["-p", "--session-id", SESSION]);
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (f.lines.some((l) => l.includes("control_request"))) {
          clearInterval(t);
          resolve();
        }
      }, 10);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.lines.some((l) => l.includes('"type":"result"'))).toBe(false);
    f.h.writeLine({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "r1",
        response: { behavior: "deny", message: "no" },
      },
    });
    const r = await f.h.closed;
    expect(r.code).toBe(0);
    expect(f.lines.some((l) => l.includes('"type":"result"'))).toBe(true);
  });

  it("exits 4 when the decision differs from expect", async () => {
    const f = start("permission-parked", ["-p", "--session-id", SESSION]);
    f.h.writeLine({
      type: "control_response",
      response: { subtype: "success", request_id: "r1", response: { behavior: "allow" } },
    });
    const r = await f.h.closed;
    expect(r.code).toBe(4);
  });

  it("rejects --bare and --continue with exit 3 like the real CLI", async () => {
    const f = start("happy", ["-p", "--bare", "--session-id", SESSION]);
    const r = await f.h.closed;
    expect(r.code).toBe(3);
    expect(f.stderr()).toMatch(/unknown option '--bare'/);
  });

  it("records the argv it received", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "argv-")), "argv.json");
    const f = start("happy", ["-p", "--resume", SESSION, "--model", "x"], {
      FAKE_CLAUDE_ARGV_OUT: out,
    });
    f.h.endInput();
    await f.h.closed;
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([
      "-p",
      "--resume",
      SESSION,
      "--model",
      "x",
    ]);
  });

  it("writes stderr steps and exits with the fixture's code", async () => {
    const f = start("crash-no-result", ["-p", "--session-id", SESSION]);
    const r = await f.h.closed;
    expect(r.code).toBe(1);
    expect(f.stderr()).toContain("boom");
    expect(f.lines.some((l) => l.includes('"type":"result"'))).toBe(false);
  });

  it("hang ignores SIGINT and is killed with its grandchild by stop()", async () => {
    const f = start("hang", ["-p", "--session-id", SESSION]);
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (f.lines.some((l) => l.includes("grandchild"))) {
          clearInterval(t);
          resolve();
        }
      }, 10);
    });
    const g = (parsed(f.lines).find((m) => "grandchild" in m) as { grandchild: number }).grandchild;
    await f.h.stop(200);
    expect((await f.h.closed).signal).toBe("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(g, 0)).toThrow(/ESRCH/);
  });
});
