import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

export type ChildHandle = {
  pid: number;
  writeLine(obj: unknown): void;
  endInput(): void;
  stop(graceMs: number): Promise<void>;
  closed: Promise<{ code: number | null; signal: string | null }>;
};

export type SpawnOptions = {
  cwd: string;
  env: Record<string, string>;
  onLine(line: string): void;
  onStderr(chunk: string): void;
  teeTo: string;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Spawns `command` detached in its own process group, reads stdout line by line, tees the
 * raw stdout to `teeTo`, and resolves `closed` on the child's `close` event (all stdio
 * flushed), never on `exit`.
 */
export function spawnLines(command: string, args: string[], opts: SpawnOptions): ChildHandle {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pid = child.pid ?? -1;
  const tee = createWriteStream(opts.teeTo, { flags: "a" });
  child.stdout.on("data", (chunk: Buffer) => {
    tee.write(chunk);
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  reader.on("line", (line) => opts.onLine(line));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => opts.onStderr(chunk));
  child.stdin.on("error", () => {
    // the child may exit before we finish writing; a broken pipe is not our failure
  });

  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("error", () => resolve({ code: null, signal: null }));
    child.on("close", (code, signal) => {
      tee.end();
      resolve({ code, signal });
    });
  });

  const killGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      // already gone
    }
  };

  return {
    pid,
    writeLine(obj) {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(obj)}\n`);
    },
    endInput() {
      if (child.stdin.writable) child.stdin.end();
    },
    async stop(graceMs) {
      killGroup("SIGINT");
      const done = await Promise.race([closed.then(() => true), sleep(graceMs).then(() => false)]);
      if (!done) {
        killGroup("SIGKILL");
        await closed;
      }
    },
    closed,
  };
}
