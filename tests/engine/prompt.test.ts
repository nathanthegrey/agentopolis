import { describe, expect, it } from "vitest";
import {
  composeFirstUserMessage,
  composeSystemPrompt,
  composeTurnPrompt,
} from "../../src/engine/prompt.js";
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

describe("composeTurnPrompt", () => {
  const messages = [
    { id: 3, container: "ceo", author: "owner", kind: "say", body: "tre" },
    { id: 1, container: "ceo", author: "owner", kind: "ask", body: "uno" },
    { id: 2, container: "agentopolis", author: "lead", kind: "report", body: "due" },
  ];
  it("groups by container in first-id order, messages in id order, ends with the tool instruction", () => {
    const out = composeTurnPrompt({ messages, outcomes: [], remembered: [] });
    expect(out.indexOf("## ceo")).toBeLessThan(out.indexOf("## agentopolis"));
    expect(out.indexOf("[#1] owner (ask): uno")).toBeLessThan(out.indexOf("[#3] owner (say): tre"));
    expect(out).toContain("[#2] lead (report): due");
    expect(out).not.toContain("# Outcomes");
    expect(out).not.toContain("# Remembered since last turn");
    expect(
      out
        .trimEnd()
        .endsWith("Rispondi solo tramite gli strumenti agentopolis; non scrivere testo libero."),
    ).toBe(true);
  });
  it("adds outcomes and remembered lines when present, in that order", () => {
    const out = composeTurnPrompt({
      messages,
      outcomes: ["request 4 approved"],
      remembered: ["x"],
    });
    expect(out.indexOf("## agentopolis")).toBeLessThan(out.indexOf("# Outcomes"));
    expect(out.indexOf("# Outcomes")).toBeLessThan(out.indexOf("# Remembered since last turn"));
    expect(out).toContain("- request 4 approved");
    expect(out).toContain("- x");
  });
  it("is byte-identical for the same input", () => {
    const a = composeTurnPrompt({ messages, outcomes: ["o"], remembered: ["r"] });
    const b = composeTurnPrompt({
      messages: [...messages].reverse(),
      outcomes: ["o"],
      remembered: ["r"],
    });
    expect(a).toBe(b);
  });
});
