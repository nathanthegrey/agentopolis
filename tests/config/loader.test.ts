import { appendFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadHome } from "../../src/config/loader.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}/`, import.meta.url));
const copyOfValid = () => {
  const d = mkdtempSync(join(tmpdir(), "home-"));
  cpSync(fixture("home-valid"), d, { recursive: true });
  return d;
};

describe("loadHome", () => {
  it("loads a valid home folder into a frozen snapshot", () => {
    const r = loadHome(fixture("home-valid"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.roles.get("ceo")?.soul).toContain("Soul");
    expect(r.snapshot.roles.get("ceo")?.tools).toEqual(["agentopolis"]);
    expect(r.snapshot.agents.get("ceo")?.display).toBe("Ada · CEO");
    expect(r.snapshot.projects.get("agentopolis")?.branches.production).toBe("master");
    expect(r.snapshot.style).toContain("Tu form");
    expect(Object.isFrozen(r.snapshot)).toBe(true);
    expect(r.snapshot.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports every error with its file, and never a partial snapshot", () => {
    const r = loadHome(fixture("home-broken"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const files = r.errors.map((e) => e.file);
    expect(files.some((f) => f.endsWith("roles/ceo/role.yaml"))).toBe(true);
    expect(files.some((f) => f.endsWith("roles/ceo/JOB.md"))).toBe(true);
    expect(files.some((f) => f.endsWith("config.yaml"))).toBe(true);
    expect(r.errors.find((e) => e.file.endsWith("config.yaml"))?.message).toMatch(/secret/i);
  });

  it("rejects an agent whose role or reports_to does not exist", () => {
    const d = copyOfValid();
    mkdirSync(join(d, "agents", "x"));
    writeFileSync(
      join(d, "agents", "x", "agent.yaml"),
      "name: x\ndisplay: X\nrole: ghost\nreports_to: nobody\n",
    );
    const r = loadHome(d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const messages = r.errors.map((e) => e.message);
    expect(messages.some((m) => m.includes("ghost"))).toBe(true);
    expect(messages.some((m) => m.includes("nobody"))).toBe(true);
    expect(r.errors.every((e) => e.file.endsWith("agents/x/agent.yaml"))).toBe(true);
  });

  it("gives the same version to identical content at different paths", () => {
    const a = loadHome(copyOfValid());
    const b = loadHome(copyOfValid());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.snapshot.dir).not.toBe(b.snapshot.dir);
    expect(a.snapshot.version).toBe(b.snapshot.version);
  });

  it("changes version when any file changes", () => {
    const d = copyOfValid();
    const first = loadHome(d);
    expect(first.ok).toBe(true);
    appendFileSync(join(d, "STYLE.md"), "Short.\n");
    const second = loadHome(d);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.snapshot.version).not.toBe(first.snapshot.version);
  });
});
