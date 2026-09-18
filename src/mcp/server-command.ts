import { fileURLToPath } from "node:url";

/** How to start agentopolis-mcp from this checkout: node + tsx + the TypeScript entry. */
export function mcpServerCommand(): { command: string; args: string[] } {
  const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const entry = fileURLToPath(new URL("./server.ts", import.meta.url));
  return { command: process.execPath, args: [tsx, entry] };
}
