import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initHome } from "../../src/cli/init.js";

describe("initHome", () => {
  it("creates a valid home from examples/home and opens its database", () => {
    const target = join(mkdtempSync(join(tmpdir(), "init-")), "home");
    const r = initHome(target);
    expect(r.snapshot.roles.has("ceo")).toBe(true);
    expect(existsSync(join(target, "data", "agentopolis.db"))).toBe(true);
    expect(existsSync(join(target, ".gitignore"))).toBe(true);
  });
  it("refuses a target that already exists", () => {
    const target = mkdtempSync(join(tmpdir(), "init-"));
    expect(() => initHome(target)).toThrow(/exists/);
  });
});
