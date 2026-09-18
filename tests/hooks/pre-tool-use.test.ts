import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hook = fileURLToPath(new URL("../../hooks/pre-tool-use.mjs", import.meta.url));
const run = (input: unknown, env: Record<string, string>) =>
  spawnSync("node", [hook], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });

describe("pre-tool-use hook", () => {
  const env = { AGENTOPOLIS_PRODUCTION_BRANCHES: "master,main" };
  it("exits 2 on a push to a production branch", () => {
    const r = run({ tool_name: "Bash", tool_input: { command: "git push origin master" } }, env);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/production/);
  });
  it("exits 2 on a push with HEAD:master and on git add -A", () => {
    expect(
      run({ tool_name: "Bash", tool_input: { command: "git push -f origin HEAD:main" } }, env)
        .status,
    ).toBe(2);
    expect(run({ tool_name: "Bash", tool_input: { command: "git add -A" } }, env).status).toBe(2);
    expect(run({ tool_name: "Bash", tool_input: { command: "git add ." } }, env).status).toBe(2);
  });
  it("exits 0 and says nothing on anything else, including a push to dev", () => {
    const dev = run({ tool_name: "Bash", tool_input: { command: "git push origin dev" } }, env);
    expect(dev.status).toBe(0);
    expect(dev.stderr).toBe("");
    expect(run({ tool_name: "Read", tool_input: { file_path: "x" } }, env).status).toBe(0);
    expect(
      run({ tool_name: "Bash", tool_input: { command: "git add src/a.ts" } }, env).status,
    ).toBe(0);
  });
  it("exits 0 and logs when it cannot evaluate its predicate", () => {
    const r = run("not json", env);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/could not/i);
  });
});
