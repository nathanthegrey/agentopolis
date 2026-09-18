import { type LoadError, loadHome, type Snapshot } from "./loader.js";

export class SnapshotHolder {
  #current: Snapshot;
  readonly dir: string;

  private constructor(dir: string, first: Snapshot) {
    this.dir = dir;
    this.#current = first;
  }

  static open(dir: string): SnapshotHolder {
    const r = loadHome(dir);
    if (!r.ok) {
      const lines = r.errors.map((e) => `  ${e.file}: ${e.message}`).join("\n");
      throw new Error(`home folder invalid:\n${lines}`);
    }
    return new SnapshotHolder(dir, r.snapshot);
  }

  get current(): Snapshot {
    return this.#current;
  }

  reload(): { ok: true; changed: boolean } | { ok: false; errors: LoadError[] } {
    const r = loadHome(this.dir);
    if (!r.ok) return r;
    const changed = r.snapshot.version !== this.#current.version;
    if (changed) this.#current = r.snapshot;
    return { ok: true, changed };
  }
}
