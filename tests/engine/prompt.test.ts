import { describe, expect, it } from "vitest";
import { composeFirstUserMessage, composeSystemPrompt } from "../../src/engine/prompt.js";
import { snapshot } from "./helpers.js";

const ceo = () => {
  const r = snapshot.roles.get("ceo");
  if (!r) throw new Error("fixture");
  return r;
};

describe("composeSystemPrompt", () => {
  it("orders style, soul, job, protocol under fixed headings and ends with a newline", () => {
    const out = composeSystemPrompt("Tu form.\n", ceo());
    const idx = (s: string) => out.indexOf(s);
    expect(idx("# Style")).toBe(0);
    expect(idx("# Style")).toBeLessThan(idx("# Who you are"));
    expect(idx("# Who you are")).toBeLessThan(idx("# Your job"));
    expect(idx("# Your job")).toBeLessThan(idx("# How you work with others"));
    expect(out).toContain("Tu form.");
    expect(out).toContain(ceo().soul.trim());
    expect(out.endsWith("\n")).toBe(true);
    expect(out).not.toContain("\n\n\n");
  });
  it("is deterministic", () => {
    expect(composeSystemPrompt("s", ceo())).toBe(composeSystemPrompt("s", ceo()));
  });
});

describe("composeFirstUserMessage", () => {
  it("sorts knowledge by name and omits the state pack when absent", () => {
    const out = composeFirstUserMessage({
      memory: "remember this",
      knowledge: [
        { name: "zeta.md", text: "Z" },
        { name: "alpha.md", text: "A" },
      ],
      state: undefined,
    });
    expect(out.indexOf("# Memory")).toBeLessThan(out.indexOf("# Project knowledge"));
    expect(out.indexOf("## alpha.md")).toBeLessThan(out.indexOf("## zeta.md"));
    expect(out).not.toContain("# State pack");
  });
  it("includes the state pack when present, after knowledge", () => {
    const out = composeFirstUserMessage({ memory: "", knowledge: [], state: "rotated" });
    expect(out.indexOf("# Project knowledge")).toBeLessThan(out.indexOf("# State pack"));
    expect(out).toContain("rotated");
  });
});
