import type { Role } from "../config/loader.js";

export function buildSettings(
  role: Role,
  productionBranches: string[] | undefined,
  hookPath: string,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    permissions: { allow: role.permissions.allow, deny: role.permissions.deny },
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
