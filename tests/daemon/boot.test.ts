import { cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startDaemon } from "../../src/daemon.js";
import { openDatabase } from "../../src/store/db.js";
import * as schema from "../../src/store/schema.js";

const VALID_HOME = fileURLToPath(new URL("../fixtures/home-valid/", import.meta.url));

function home(): string {
  const d = mkdtempSync(join(tmpdir(), "daemon-home-"));
  cpSync(VALID_HOME, d, { recursive: true });
  return d;
}

const openStore = (dir: string) => openDatabase(join(dir, "data", "agentopolis.db"));

describe("daemon boot", () => {
  it("creates the store, upserts the standing agents and opens their containers", async () => {
    const dir = home();
    const d = await startDaemon({ home: dir, fake: true });
    try {
      expect(existsSync(join(dir, "data", "agentopolis.db"))).toBe(true);
      const db = openStore(dir);
      const agents = db.orm
        .select()
        .from(schema.agents)
        .all()
        .map((a) => a.name)
        .sort();
      expect(agents).toEqual(["ada", "ceo", "nina"]);
      expect(
        db.orm
          .select()
          .from(schema.agents)
          .all()
          .every((a) => a.role !== ""),
      ).toBe(true);

      // the ceo's direct message and the project's two channels
      const containers = db.orm
        .select()
        .from(schema.containers)
        .all()
        .map((c) => c.name)
        .sort();
      expect(containers).toContain("dm:ceo");
      expect(containers).toContain("agentopolis-hq");
      expect(containers).toContain("agentopolis-work");
      db.close();
    } finally {
      await d.stop(1_000);
    }
  });

  it("records that it booted, with the configuration version that ran", async () => {
    const dir = home();
    const d = await startDaemon({ home: dir, fake: true });
    try {
      const db = openStore(dir);
      const booted = db.orm
        .select()
        .from(schema.events)
        .all()
        .find((e) => e.kind === "daemon.booted");
      expect((booted?.payload as { version: string } | undefined)?.version).toBe(
        d.holder.current.version,
      );
      db.close();
    } finally {
      await d.stop(1_000);
    }
  });

  it("answers /healthz on localhost with what the owner would ask", async () => {
    const dir = home();
    const port = 41_000 + Math.floor(Math.random() * 2_000);
    const d = await startDaemon({ home: dir, fake: true, healthPort: port });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.runningTurns).toBe(0);
      expect(body.queueDepth).toBe(0);
      expect(body.limitPausedUntil).toBeNull();
      expect(body.configVersion).toBe(d.holder.current.version);

      const missing = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await d.stop(1_000);
    }
  });

  it("refuses to boot on a malformed home folder rather than starting half a company", async () => {
    const dir = home();
    writeFileSync(join(dir, "config.yaml"), "slack: {oops\n");
    await expect(startDaemon({ home: dir, fake: true })).rejects.toThrow(/home folder invalid/);
  });

  it("reloads the folder when a file changes, and keeps the last good one when it breaks", async () => {
    const dir = home();
    const d = await startDaemon({ home: dir, fake: true });
    try {
      const before = d.holder.current.version;
      writeFileSync(join(dir, "STYLE.md"), "Tu form. Sempre.\n");
      await waitFor(() => d.holder.current.version !== before).catch((e) => {
        throw new Error(`${(e as Error).message}; events=${allEventKinds(dir).join(",")}`);
      });
      expect(d.holder.current.version).not.toBe(before);

      const good = d.holder.current.version;
      writeFileSync(join(dir, "roles", "ceo", "role.yaml"), "name: ceo\nkind: nonsense\n");
      await waitFor(() => rejectedEvents(dir) > 0);
      // the last valid snapshot is still the one loaded
      expect(d.holder.current.version).toBe(good);
    } finally {
      await d.stop(1_000);
    }
  }, 45_000);

  it("stops in order and leaves the database usable", async () => {
    const dir = home();
    const d = await startDaemon({ home: dir, fake: true });
    await d.stop(1_000);
    const db = openStore(dir);
    expect(db.orm.select().from(schema.agents).all().length).toBeGreaterThan(0);
    db.close();
  });
});

function allEventKinds(dir: string): string[] {
  const db = openStore(dir);
  const kinds = db.orm
    .select()
    .from(schema.events)
    .all()
    .map((e) => e.kind);
  db.close();
  return kinds;
}

function rejectedEvents(dir: string): number {
  const db = openStore(dir);
  const n = db.orm
    .select()
    .from(schema.events)
    .all()
    .filter((e) => e.kind === "config.rejected").length;
  db.close();
  return n;
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the daemon");
    await new Promise((r) => setTimeout(r, 50));
  }
}
