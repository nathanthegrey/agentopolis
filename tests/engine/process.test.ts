import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnLines } from "../../src/engine/process.js";
import { expectGone } from "./helpers.js";

const child = (name: string) =>
  fileURLToPath(new URL(`../fixtures/children/${name}`, import.meta.url));
const tee = () => join(mkdtempSync(join(tmpdir(), "tee-")), "run.ndjson");
const env = { PATH: process.env.PATH ?? "" };

describe("spawnLines", () => {
  it("delivers lines in order and resolves closed with the exit code", async () => {
    const lines: string[] = [];
    const h = spawnLines("node", [child("echo-lines.mjs")], {
      cwd: tmpdir(),
      env,
      onLine: (l) => lines.push(l),
      onStderr: () => {},
      teeTo: tee(),
    });
    expect(h.pid).toBeGreaterThan(0);
    const r = await h.closed;
    expect(r).toEqual({ code: 0, signal: null });
    expect(lines).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
  });

  it("does not lose a 1 MB burst: every line arrives before closed resolves, and the tee has them all", async () => {
    let received = 0;
    let bytes = 0;
    const file = tee();
    const h = spawnLines("node", [child("big-burst.mjs")], {
      cwd: tmpdir(),
      env: { ...env, BURST_LINES: "10000" },
      onLine: (l) => {
        received += 1;
        bytes += l.length + 1;
      },
      onStderr: () => {},
      teeTo: file,
    });
    await h.closed;
    expect(received).toBe(10_000);
    expect(bytes).toBeGreaterThan(1_000_000);
    const teed = readFileSync(file, "utf8");
    expect(teed.split("\n").filter(Boolean)).toHaveLength(10_000);
  });

  it("round-trips stdin lines and ends input", async () => {
    const lines: string[] = [];
    let stderr = "";
    const h = spawnLines("node", [child("echo-stdin.mjs")], {
      cwd: tmpdir(),
      env,
      onLine: (l) => lines.push(l),
      onStderr: (c) => {
        stderr += c;
      },
      teeTo: tee(),
    });
    h.writeLine({ a: 1 });
    h.writeLine("two");
    h.endInput();
    const r = await h.closed;
    expect(r.code).toBe(0);
    expect(lines).toEqual(['{"echo":{"a":1}}', '{"echo":"two"}']);
    expect(stderr).toContain("stdin ended");
  });

  it("stop(): SIGINT to the group, then SIGKILL; the grandchild dies with the group", async () => {
    let grandchild = 0;
    const h = spawnLines("node", [child("ignore-sigint.mjs")], {
      cwd: tmpdir(),
      env,
      onLine: (l) => {
        grandchild = (JSON.parse(l) as { grandchild: number }).grandchild;
      },
      onStderr: () => {},
      teeTo: tee(),
    });
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (grandchild) {
          clearInterval(t);
          resolve();
        }
      }, 10);
    });
    const started = Date.now();
    await h.stop(200);
    const r = await h.closed;
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(r.signal).toBe("SIGKILL");
    // the grandchild `sleep 60` was in the same process group and must be gone
    await expectGone(grandchild);
  });

  it("stop() on a child that already exited resolves without throwing", async () => {
    const h = spawnLines("node", [child("echo-lines.mjs")], {
      cwd: tmpdir(),
      env,
      onLine: () => {},
      onStderr: () => {},
      teeTo: tee(),
    });
    await h.closed;
    await expect(h.stop(50)).resolves.toBeUndefined();
  });
});
