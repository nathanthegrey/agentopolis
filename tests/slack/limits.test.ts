import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertBlocks, LIMITS, splitText, truncateButton } from "../../src/slack/limits.js";

const stripFences = (s: string) =>
  s.replaceAll("\n```\n", "").replaceAll("```\n", "").replaceAll("\n```", "").replaceAll("```", "");

describe("splitText", () => {
  it("leaves short text unchanged", () => {
    expect(splitText("ciao")).toEqual(["ciao"]);
    expect(splitText("")).toEqual([""]);
  });
  it("splits a 7,000-char text into parts of at most 3,000 on paragraph boundaries", () => {
    const para = `${"a".repeat(1400)}\n\n`;
    const text = para.repeat(5).trimEnd(); // 5 × 1400 + separators ≈ 7,008
    const parts = splitText(text);
    expect(parts.length).toBe(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(LIMITS.sectionText);
    expect(parts.join("")).toBe(text);
  });
  it("closes and reopens a code fence that would be cut", () => {
    const code = `\`\`\`\n${"x".repeat(2990)}\n${"y".repeat(100)}\n\`\`\``;
    const parts = splitText(code);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(LIMITS.sectionText);
      expect((p.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(stripFences(parts.join(""))).toBe(stripFences(code));
  });
  it("hard-cuts a single word longer than the limit", () => {
    const parts = splitText("z".repeat(6500));
    expect(parts.map((p) => p.length)).toEqual([3000, 3000, 500]);
    expect(parts.join("")).toBe("z".repeat(6500));
  });
  it("property: every part fits; backtick-free text concatenates back exactly", () => {
    const plain = fc.string({ maxLength: 12_000 }).filter((s) => !s.includes("`"));
    fc.assert(
      fc.property(plain, fc.integer({ min: 12, max: 3000 }), (text, max) => {
        const parts = splitText(text, max);
        return parts.every((p) => p.length <= max) && parts.join("") === text;
      }),
      { numRuns: 300 },
    );
  });
  it("property: with fences, every part fits, our markers never unbalance a part, and only markers are added", () => {
    const normalize = (s: string) => s.replaceAll("```", "").replaceAll("\n", "");
    const fences = (s: string) => (s.match(/```/g) ?? []).length;
    const withFences = fc
      .array(fc.oneof(fc.string({ maxLength: 400 }), fc.constant("```"), fc.constant("\n")), {
        maxLength: 40,
      })
      .map((xs) => xs.join(""))
      // a Slack fence is exactly three backticks; longer runs are not fences and not markdown
      .filter((s) => !s.includes("````"));
    fc.assert(
      fc.property(withFences, fc.integer({ min: 12, max: 3000 }), (text, max) => {
        const parts = splitText(text, max);
        const balancedInput = fences(text) % 2 === 0;
        return (
          parts.every((p) => p.length <= max) &&
          parts.slice(0, -1).every((p) => fences(p) % 2 === 0) &&
          (!balancedInput || fences(parts.at(-1) ?? "") % 2 === 0) &&
          normalize(parts.join("")) === normalize(text)
        );
      }),
      { numRuns: 300 },
    );
  });
});

describe("assertBlocks / truncateButton", () => {
  it("throws with a clear message over the cap", () => {
    expect(() => assertBlocks(new Array(51).fill({}), LIMITS.blocksPerMessage)).toThrow(
      /51 blocks .* 50/,
    );
    expect(() => assertBlocks(new Array(50).fill({}), LIMITS.blocksPerMessage)).not.toThrow();
  });
  it("truncates button text to 75 characters with an ellipsis", () => {
    expect(truncateButton("x".repeat(80))).toHaveLength(75);
    expect(truncateButton("x".repeat(80)).endsWith("…")).toBe(true);
    expect(truncateButton("ok")).toBe("ok");
  });
});
