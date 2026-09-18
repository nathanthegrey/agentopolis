import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mcpServerCommand } from "../../src/mcp/server-command.js";
import { startToolSocket, type ToolSocket } from "../../src/mcp/socket-server.js";
import type { ToolHandlers } from "../../src/mcp/tools.js";

const path = join(mkdtempSync(join(tmpdir(), "sock-")), "d.sock");
let socket: ToolSocket;
const statusResult = { budget_left_usd: "12.00", open_asks: 1 };
const seen: unknown[] = [];
const handlers: ToolHandlers = {
  post: async (_c, i) => {
    seen.push(i);
    return { message_id: 42 };
  },
  answer: async () => null,
  read_channel: async () => [],
  request: async () => {
    throw new Error("not allowed for your role");
  },
  remember: async () => null,
  status: async () => statusResult,
};

async function client(token: string) {
  const cmd = mcpServerCommand();
  const transport = new StdioClientTransport({
    command: cmd.command,
    args: cmd.args,
    env: { PATH: process.env.PATH ?? "", AGENTOPOLIS_SOCKET: path, AGENTOPOLIS_TOKEN: token },
    stderr: "pipe",
  });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(transport);
  return c;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[])[0]?.text ?? "";

describe("agentopolis-mcp stdio server", () => {
  beforeAll(async () => {
    socket = await startToolSocket({
      path,
      tokens: new Map([["t-1", { agent: "ceo", turnId: 3 }]]),
      handlers,
    });
  });
  afterAll(async () => {
    await socket.close();
  });

  it("lists the six tools and forwards a status call to the daemon", async () => {
    const c = await client("t-1");
    const tools = await c.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "answer",
      "post",
      "read_channel",
      "remember",
      "request",
      "status",
    ]);
    const r = await c.callTool({ name: "status", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toEqual(statusResult);
    const p = await c.callTool({
      name: "post",
      arguments: { container: "ceo", to: "owner", body: "ciao", kind: "ask" },
    });
    expect(JSON.parse(text(p))).toEqual({ message_id: 42 });
    expect(seen[0]).toEqual({ container: "ceo", to: "owner", body: "ciao", kind: "ask" });
    const e = await c.callTool({ name: "request", arguments: { kind: "hire", payload: {} } });
    expect(e.isError).toBe(true);
    expect(text(e)).toContain("not allowed");
    await c.close();
  }, 20_000);

  it("returns isError when the token is wrong, and never throws", async () => {
    const c = await client("wrong");
    const r = await c.callTool({ name: "status", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/unknown token/);
    await c.close();
  }, 20_000);
});
