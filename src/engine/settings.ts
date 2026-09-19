import type { Role } from "../config/loader.js";

/**
 * The highest effort any agent may run at (owner, 2026-09-19: no xhigh anywhere). The CLI has a
 * settings key for it, so the rule is enforced rather than merely written (principle 4):
 * `maxEffortLevel` — "Maximum effort level. Anything above it (an /effort or /model pick,
 * --effort, CLAUDE_CODE_EFFORT_LEVEL, a model default) ... Enforced client-side"
 * [verified 2026-09-19 in the installed claude 2.1.277 bundle; live check 8d].
 */
export const MAX_EFFORT_LEVEL = "high";

export function buildSettings(
  role: Role,
  productionBranches: string[] | undefined,
  hookPath: string,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    permissions: { allow: role.permissions.allow, deny: role.permissions.deny },
    maxEffortLevel: MAX_EFFORT_LEVEL,
  };
  if (role.permissions.hooks.includes("deny_push_to_production") && productionBranches?.length) {
    settings.hooks = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: `AGENTOPOLIS_PRODUCTION_BRANCHES=${productionBranches.join(",")} node ${hookPath}`,
              timeout: 10,
            },
          ],
        },
      ],
    };
  }
  return settings;
}
