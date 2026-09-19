import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHome, type Snapshot } from "../../src/config/loader.js";
import { FakeClock } from "../../src/ports/clock.js";
import { type Db, openDatabase } from "../../src/store/db.js";
import * as schema from "../../src/store/schema.js";

export const VALID_HOME = fileURLToPath(new URL("../fixtures/home-valid/", import.meta.url));

/** A writable copy of the valid fixture, so MEMORY.md writes have somewhere to land. */
export function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), "home-"));
  cpSync(VALID_HOME, d, { recursive: true });
  return d;
}

export type World = { db: Db; clock: FakeClock; snapshot: Snapshot; home: string };

export function world(start = 1_000): World {
  const home = tempHome();
  const loaded = loadHome(home);
  if (!loaded.ok) throw new Error(`home-valid does not load: ${JSON.stringify(loaded.errors)}`);
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "db-")), "a.db"));
  return { db, clock: new FakeClock(start), snapshot: loaded.snapshot, home };
}

export function container(
  db: Db,
  c: {
    kind: "dm" | "standing" | "task";
    name: string;
    members: string[];
    defaultTo: string;
    taskId?: number;
  },
): number {
  return db.orm
    .insert(schema.containers)
    .values({
      kind: c.kind,
      name: c.name,
      members: c.members,
      defaultTo: c.defaultTo,
      taskId: c.taskId ?? null,
      slackChannel: `C-${c.name}`,
    })
    .returning({ id: schema.containers.id })
    .get().id;
}

/** A job agent: a row, never a folder (spec section 4). */
export function jobAgent(
  db: Db,
  a: { name: string; role: string; project?: string; reportsTo?: string; taskId?: number },
): void {
  db.orm
    .insert(schema.agents)
    .values({
      name: a.name,
      role: a.role,
      display: a.name,
      project: a.project ?? null,
      reportsTo: a.reportsTo ?? null,
      kind: "job",
      taskId: a.taskId ?? null,
    })
    .run();
}

export const eventKinds = (db: Db): string[] =>
  db.orm
    .select()
    .from(schema.events)
    .all()
    .map((e) => e.kind);
