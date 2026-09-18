// agentopolis-mcp: a stdio MCP server spawned per turn by the CLI. It holds no state, never
// opens SQLite, and forwards every tool call over the daemon's unix socket with the turn's
// token. Errors come back as isError results, never thrown.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { callDaemon } from "./socket-client.js";
import { TOOL_NAMES, TOOL_SHAPES } from "./tools.js";

const socketPath = process.env.AGENTOPOLIS_SOCKET ?? "";
const token = process.env.AGENTOPOLIS_TOKEN ?? "";

const server = new McpServer({ name: "agentopolis", version: "0.1.0" });

for (const name of TOOL_NAMES) {
  const shape = TOOL_SHAPES[name];
  server.registerTool(
    name,
    { description: shape.description, inputSchema: shape.input },
    async (input: Record<string, unknown>) => {
      try {
        const result = await callDaemon(socketPath, token, name, input);
        return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
