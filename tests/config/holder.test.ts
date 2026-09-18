import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SnapshotHolder } from "../../src/config/holder.js";

const valid = fileURLToPath(new URL("../fixtures/home-valid/", import.meta.url));
const copy = () => {
  const d = mkdtempSync(join(tmpdir(), "home-"));
  cpSync(valid, d, { recursive: true });
  return d;
};

describe("SnapshotHolder", () => {
  it("throws when the first load fails", () => {
    const d = copy();
    writeFileSync(join(d, "config.yaml"), "not: [valid");
    expect(() => SnapshotHolder.open(d)).toThrow(/config\.yaml/);
  });
  it("keeps the last good snapshot when a reload fails, and reports the errors", () => {
    const d = copy();
    const h = SnapshotHolder.open(d);
    const v1 = h.current.version;
    writeFileSync(join(d, "roles", "ceo", "role.yaml"), "kind: daemon\n");
    const r = h.reload();
    expect(r.ok).toBe(false);
    expect(h.current.version).toBe(v1);
  });
  it("swaps to the new snapshot when a reload succeeds", () => {
    const d = copy();
    const h = SnapshotHolder.open(d);
    const v1 = h.current.version;
    writeFileSync(join(d, "STYLE.md"), "Tu form. Decision first. Short.\n");
    const r = h.reload();
    expect(r).toEqual({ ok: true, changed: true });
    expect(h.current.version).not.toBe(v1);
    expect(h.reload()).toEqual({ ok: true, changed: false });
  });
});
