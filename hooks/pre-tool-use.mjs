#!/usr/bin/env node
// PreToolUse hook. Exit 2 = hard deny (cannot be overridden). Exit 0 = no opinion.
// A hook that cannot evaluate its predicate says so on stderr and allows (spec principle 4).
import { readFileSync } from "node:fs";

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch (e) {
  console.error(`pre-tool-use: could not parse the hook payload (${e.message}); allowing`);
  process.exit(0);
}
if (payload?.tool_name !== "Bash" || typeof payload?.tool_input?.command !== "string") {
  process.exit(0);
}
const command = payload.tool_input.command;
const production = (process.env.AGENTOPOLIS_PRODUCTION_BRANCHES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (/\bgit\s+add\s+(-A|--all|\.)(\s|$)/.test(command)) {
  console.error("pre-tool-use: blind staging (git add -A / .) is refused; stage explicit paths");
  process.exit(2);
}
if (/\bgit\s+push\b/.test(command)) {
  for (const branch of production) {
    const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(\\s|:)${escaped}(\\s|$)`);
    if (re.test(command)) {
      console.error(
        `pre-tool-use: push to production branch "${branch}" is refused; ask the owner through merge_production`,
      );
      process.exit(2);
    }
  }
}
process.exit(0);
