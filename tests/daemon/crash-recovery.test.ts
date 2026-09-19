// The daemon is killed mid-turn and restarted; the invariants of spec section 13 must hold.
// The daemon under test runs against fake-claude and FakeChat, so nothing here touches Slack
// or the real CLI.
import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../../src/daemon.js";
import { SystemClock } from "../../src/ports/clock.js";
import { type Db, openDatabase } from "../../src/store/db.js";
import { appendMessage } from "../../src/store/messages.js";
import * as schema from "../../src/store/schema.js";

const VALID_HOME = fileURLToPath(new URL("../fixtures/home-valid/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../tools/fake-claude/fixtures/", import.meta.url));
const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));

let child: ChildProcess | undefined;

afterEach(() => {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  child = undefined;
});

function home(): string {
  const d = mkdtempSync(join(tmpdir(), "crash-home-"));
  cpSync(VALID_HOME, d, { recursive: true });
  return d;
}

const store = (dir: string): Db => openDatabase(join(dir, "data", "agentopolis.db"));

async function waitFor<T>(read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the daemon");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("crash recovery", () => {
  it("a kill -9 mid-turn loses no message: the turn is interrupted, never re-run, and the loop runs again", async () => {
    const dir = home();

    // a first boot opens the containers, then stops cleanly
    const first = await startDaemon({ home: dir, fake: true });
    await first.stop(1_000);

    // the owner writes to the ceo
    const seed = store(dir);
    const dm = seed.orm
      .select()
      .from(schema.containers)
      .where(eq(schema.containers.name, "dm:ceo"))
      .get();
    expect(dm).toBeDefined();
    const owner = appendMessage(seed, new SystemClock(), {
      containerId: dm?.id ?? 1,
      author: "owner",
      to: "ceo",
      body: "ciao, ci sei?",
      kind: "say",
    });
    seed.close();

    // the daemon runs as a child, on a fixture that hangs and ignores SIGINT
    child = spawn(process.execPath, [TSX, MAIN, "start", dir, "--fake"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FAKE_CLAUDE_DIR: FIXTURES,
        FAKE_CLAUDE_FIXTURE: "hang",
      },
    });

    let childLog = "";
    let seen = "none";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      childLog += d;
    });
    child.stderr?.on("data", (d: string) => {
      childLog += d;
    });
    child.on("close", (code) => {
      childLog += `\n[child closed ${code}]`;
    });

    const running = await waitFor(() => {
      const db = store(dir);
      const turn = db.orm.select().from(schema.turns).get();
      const all = db.orm.select().from(schema.turns).all();
      db.close();
      seen = JSON.stringify(all);
      return turn?.status === "running" ? turn : undefined;
    }).catch((e) => {
      throw new Error(
        `${(e as Error).message}\nTURNS: ${seen}\nCHILD LOG:\n${childLog.slice(0, 3000)}`,
      );
    });
    if (childLog) console.error("CHILD LOG:", childLog.slice(0, 3000));
    expect(running.agent).toBe("ceo");
    expect(running.pid).not.toBeNull();

    // the daemon dies without a chance to write anything
    process.kill(-(child.pid ?? 0), "SIGKILL");
    child = undefined;
    await new Promise((r) => setTimeout(r, 300));

    // it comes back, on a fixture that answers properly
    process.env.FAKE_CLAUDE_DIR = FIXTURES;
    process.env.FAKE_CLAUDE_FIXTURE = "envelope-hello";
    const second = await startDaemon({ home: dir, fake: true });
    try {
      const db = store(dir);

      // the interrupted turn is interrupted, and was never re-run
      const cut = db.orm.select().from(schema.turns).where(eq(schema.turns.id, running.id)).get();
      expect(cut?.status).toBe("interrupted");

      // the owner's message was consumed exactly once, by the turn that was cut
      const deliveries = db.orm
        .select()
        .from(schema.turnMessages)
        .where(eq(schema.turnMessages.messageId, owner.messageId))
        .all();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.turnId).toBe(running.id);

      // the agent was told its turn was cut, and that note woke it again
      const note = db.orm
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.kind, "system"))
        .get();
      expect(note?.to).toBe("ceo");
      expect(note?.body).toMatch(/interrotto/);
      db.close();

      // the note woke it: a second turn ran, and this one finished properly
      const ran = await waitFor(() => {
        const d2 = store(dir);
        const turns = d2.orm.select().from(schema.turns).where(eq(schema.turns.agent, "ceo")).all();
        d2.close();
        return turns.some((t) => t.id !== running.id && t.status === "ok") ? turns : undefined;
      });
      expect(ran.length).toBeGreaterThan(1);
      expect(ran.filter((t) => t.status === "interrupted").map((t) => t.id)).toEqual([running.id]);
    } finally {
      await second.stop(2_000);
    }
  }, 60_000);
});
