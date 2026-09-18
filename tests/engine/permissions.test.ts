import { describe, expect, it } from "vitest";
import { decide, matchRule } from "../../src/engine/permissions.js";

describe("matchRule", () => {
  it("matches bare tools and Bash prefixes with the space-star rule", () => {
    expect(matchRule("Read", "Read", {})).toBe(true);
    expect(matchRule("Read", "Write", {})).toBe(false);
    expect(matchRule("Bash(git diff *)", "Bash", { command: "git diff main" })).toBe(true);
    expect(matchRule("Bash(git diff *)", "Bash", { command: "git diff" })).toBe(true);
    expect(matchRule("Bash(git diff *)", "Bash", { command: "git diff-index" })).toBe(false);
    expect(matchRule("Bash(git diff*)", "Bash", { command: "git diff-index" })).toBe(true);
    expect(matchRule("Bash(npm test)", "Bash", { command: "npm test" })).toBe(true);
    expect(matchRule("Bash(npm test)", "Bash", { command: "npm test --watch" })).toBe(false);
    expect(matchRule("Bash(*)", "Bash", { command: "anything" })).toBe(true);
    expect(matchRule("Bash(git *)", "Bash", {})).toBe(false);
    expect(matchRule("mcp__github__*", "mcp__github__create_issue", {})).toBe(true);
    expect(matchRule("mcp__github__create_issue", "mcp__github__create_issue", {})).toBe(true);
    expect(matchRule("mcp__github__*", "mcp__slack__post", {})).toBe(false);
    expect(matchRule("", "Bash", {})).toBe(false);
  });
});

describe("decide", () => {
  const role = { permissions: { allow: ["Bash(git *)", "Read"], deny: ["Bash(git push *)"] } };
  const req = (toolName: string, command: string) => ({
    requestId: "r",
    toolUseId: "t",
    toolName,
    input: { command },
    suggestions: undefined,
  });
  it("deny beats allow; allow beats parked", () => {
    expect(decide(role, req("Bash", "git push origin dev"))).toBe("deny");
    expect(decide(role, req("Bash", "git status"))).toBe("allow");
    expect(decide(role, req("Read", ""))).toBe("allow");
    expect(decide(role, req("Bash", "rm -rf /"))).toBe("parked");
    expect(decide(role, req("WebFetch", ""))).toBe("parked");
  });
});
