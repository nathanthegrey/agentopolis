// The whole company, end to end, with no Slack and no real CLI: the owner writes in the ceo's
// direct message and the ceo answers from its turn's envelope, with no post call (done-when 2).
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon } from "../../src/daemon.js";
import { openDatabase } from "../../src/store/db.js";
import * as schema from "../../src/store/schema.js";

const VALID_HOME = fileURLToPath(new URL("../fixtures/home-valid/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../tools/fake-claude/fixtures/", import.meta.url));

function home(): string {
  const d = mkdtempSync(join(tmpdir(), "e2e-home-"));
  cpSync(VALID_HOME, d, { recursive: true });
  return d;
}

const store = (dir: string) => openDatabase(join(dir, "data", "agentopolis.db"));

async function waitFor<T>(read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the daemon");
    await new Promise((r) => setTimeout(r, 50));
  }
}

let previous: { dir?: string | undefined; fixture?: string | undefined } = {};

beforeEach(() => {
  previous = { dir: process.env.FAKE_CLAUDE_DIR, fixture: process.env.FAKE_CLAUDE_FIXTURE };
  process.env.FAKE_CLAUDE_DIR = FIXTURES;
  process.env.FAKE_CLAUDE_FIXTURE = "envelope-hello";
});

afterEach(() => {
  if (previous.dir === undefined) delete process.env.FAKE_CLAUDE_DIR;
  else process.env.FAKE_CLAUDE_DIR = previous.dir;
  if (previous.fixture === undefined) delete process.env.FAKE_CLAUDE_FIXTURE;
  else process.env.FAKE_CLAUDE_FIXTURE = previous.fixture;
});

describe("end to end, in --fake mode", () => {
  it("the owner writes to the ceo and gets the envelope's answer back, in one turn", async () => {
    const dir = home();
    const d = await startDaemon({ home: dir, fake: true });
    try {
      const db = store(dir);
      const dm = db.orm
        .select()
        .from(schema.containers)
        .where(eq(schema.containers.name, "dm:ceo"))
        .get();
      expect(dm?.slackChannel).toBeDefined();
      db.close();

      d.ownerSays(dm?.slackChannel ?? "", "ciao, chi sei?");

      // the reply the envelope carried, addressed to the owner
      const reply = await waitFor(() => {
        const d2 = store(dir);
        const row = d2.orm
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.author, "ceo"))
          .get();
        d2.close();
        return row;
      });
      expect(reply.to).toBe("owner");
      expect(reply.body).toBe("Ciao, sono Jarvis.");
      expect(reply.kind).toBe("say");

      const db2 = store(dir);

      // exactly one turn ran, and its cost was recorded as an integer in micro-USD
      const turns = db2.orm.select().from(schema.turns).all();
      expect(turns).toHaveLength(1);
      expect(turns[0]?.agent).toBe("ceo");
      expect(turns[0]?.status).toBe("ok");
      expect(turns[0]?.costMicrousd).toBe(1_500);
      expect(Number.isInteger(turns[0]?.costMicrousd)).toBe(true);
      expect(turns[0]?.cacheRead).toBe(1_100);

      // the owner's message was consumed exactly once
      const owner = db2.orm
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.author, "owner"))
        .get();
      const deliveries = db2.orm
        .select()
        .from(schema.turnMessages)
        .where(eq(schema.turnMessages.messageId, owner?.id ?? 0))
        .all();
      expect(deliveries).toHaveLength(1);

      // and the reply is queued for Slack, which nothing in this test ever touched
      const outbox = db2.orm.select().from(schema.outbox).all();
      const mirrored = outbox.filter(
        (o) => (o.payload as { messageId?: number }).messageId === reply.id,
      );
      expect(mirrored).toHaveLength(1);
      expect(mirrored[0]?.kind).toBe("mirror.message");
      db2.close();
    } finally {
      await d.stop(2_000);
    }
  }, 60_000);

  it("a second message runs a second turn, and neither message is read twice", async () => {
    const dir = home();
    const d = await startDaemon({ home: dir, fake: true });
    try {
      const db = store(dir);
      const channel =
        db.orm.select().from(schema.containers).where(eq(schema.containers.name, "dm:ceo")).get()
          ?.slackChannel ?? "";
      db.close();

      d.ownerSays(channel, "prima");
      await waitFor(() => {
        const d2 = store(dir);
        const n = d2.orm.select().from(schema.turns).all().length;
        d2.close();
        return n === 1 ? n : undefined;
      });

      d.ownerSays(channel, "seconda");
      await waitFor(() => {
        const d2 = store(dir);
        const done = d2.orm
          .select()
          .from(schema.turns)
          .all()
          .filter((t) => t.status === "ok");
        d2.close();
        return done.length === 2 ? done : undefined;
      });

      const db2 = store(dir);
      const delivered = db2.orm.select().from(schema.turnMessages).all();
      expect(new Set(delivered.map((t) => t.messageId)).size).toBe(delivered.length);
      db2.close();
    } finally {
      await d.stop(2_000);
    }
  }, 60_000);
});
