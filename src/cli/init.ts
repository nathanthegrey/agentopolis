import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SnapshotHolder } from "../config/holder.js";
import type { Snapshot } from "../config/loader.js";
import { openDatabase } from "../store/db.js";

const EXAMPLE = fileURLToPath(new URL("../../examples/home/", import.meta.url));

export function initHome(target: string): { snapshot: Snapshot; dbPath: string } {
  if (existsSync(target)) throw new Error(`initHome: ${target} already exists`);
  cpSync(EXAMPLE, target, { recursive: true });
  mkdirSync(join(target, "data"), { recursive: true });
  mkdirSync(join(target, "runs"), { recursive: true });
  writeFileSync(join(target, ".gitignore"), "data/\nruns/\n");
  const holder = SnapshotHolder.open(target);
  const dbPath = join(target, "data", "agentopolis.db");
  openDatabase(dbPath).close();
  return { snapshot: holder.current, dbPath };
}
