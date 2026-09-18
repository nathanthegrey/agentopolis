import type { Role } from "../config/loader.js";
import type { ConfigFile } from "../config/schemas.js";

type Catalogue = ConfigFile["mcp_servers"];

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(rec)
        .sort()
        .map((k) => [k, sortKeys(rec[k])]),
    );
  }
  return value;
}

export function buildMcpConfig(
  role: Role,
  catalogue: Catalogue,
  agentopolis: { command: string; args: string[] },
): string {
  const servers: Record<string, unknown> = {
    agentopolis: {
      type: "stdio",
      command: agentopolis.command,
      args: agentopolis.args,
      alwaysLoad: true,
    },
  };
  for (const name of [...role.tools].sort()) {
    if (name === "agentopolis") continue;
    const def = catalogue[name];
    if (!def) {
      throw new Error(
        `role ${role.name} names MCP server "${name}" which config.yaml does not define`,
      );
    }
    servers[name] = { type: "stdio", command: def.command, args: def.args, env: def.env };
  }
  return JSON.stringify(sortKeys({ mcpServers: servers }));
}
