import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { startToolSocket } from "../../src/mcp/socket-server.js";
import type { ToolContext, ToolHandlers } from "../../src/mcp/tools.js";

const fakeHandlers = (
  calls: { name: string; ctx: ToolContext; input: unknown }[],
): ToolHandlers => {
  const h = async (name: string, ctx: ToolContext, input: unknown) => {
    calls.push({ name, ctx, input });
    if (name === "remember") throw new Error("disk full");
    return { ok: name };
  };
  return {
    post: (c, i) => h("post", c, i),
    answer: (c, i) => h("answer", c, i),
    read_channel: (c, i) => h("read_channel", c, i),
    request: (c, i) => h("request", c, i),
    remember: (c, i) => h("remember", c, i),
    status: (c, i) => h("status", c, i),
  };
};

async function talk(path: string, lines: unknown[]): Promise<Record<string, unknown>[]> {
  const socket = connect(path);
  const replies: Record<string, unknown>[] = [];
  const rl = createInterface({ input: socket });
  rl.on("line", (l) => replies.push(JSON.parse(l)));
  await new Promise((r) => socket.on("connect", r));
  for (const l of lines) socket.write(`${JSON.stringify(l)}\n`);
  await new Promise((r) => {
    socket.on("close", r);
    setTimeout(() => socket.end(), 150);
  });
  return replies;
}

describe("tool socket", () => {
  const setup = async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sock-")), "d.sock");
    const calls: { name: string; ctx: ToolContext; input: unknown }[] = [];
    const tokens = new Map([["tok-1", { agent: "ceo", turnId: 7 }]]);
    const server = await startToolSocket({ path, tokens, handlers: fakeHandlers(calls) });
    return { path, calls, server };
  };

  it("rejects an unknown token and closes", async () => {
    const t = await setup();
    const replies = await talk(t.path, [
      { hello: { token: "nope" } },
      { id: 1, tool: "status", input: {} },
    ]);
    expect(replies).toEqual([{ error: "unknown token" }]);
    expect(t.calls).toHaveLength(0);
    await t.server.close();
  });

  it("dispatches a validated post to the handler with the token's context", async () => {
    const t = await setup();
    const replies = await talk(t.path, [
      { hello: { token: "tok-1" } },
      { id: 1, tool: "post", input: { container: "ceo", to: "owner", body: "ciao", kind: "say" } },
    ]);
    expect(replies[0]).toEqual({ hello: "ok", agent: "ceo", turnId: 7 });
    expect(replies[1]).toEqual({ id: 1, result: { ok: "post" } });
    expect(t.calls[0]?.ctx).toEqual({ agent: "ceo", turnId: 7 });
    expect(t.calls[0]?.input).toEqual({ container: "ceo", to: "owner", body: "ciao", kind: "say" });
    await t.server.close();
  });

  it("answers errors for bad input, unknown tools and throwing handlers, and keeps serving", async () => {
    const t = await setup();
    const replies = await talk(t.path, [
      { hello: { token: "tok-1" } },
      { id: 1, tool: "post", input: { container: "ceo", to: "owner", body: "x", kind: "shout" } },
      { id: 2, tool: "explode", input: {} },
      { id: 3, tool: "remember", input: { text: "hi" } },
      { id: 4, tool: "status", input: {} },
    ]);
    expect(replies.map((r) => r.id)).toEqual([undefined, 1, 2, 3, 4]);
    expect(String(replies[1]?.error)).toMatch(/kind/);
    expect(String(replies[2]?.error)).toMatch(/unknown tool explode/);
    expect(replies[3]).toEqual({ id: 3, error: "disk full" });
    expect(replies[4]).toEqual({ id: 4, result: { ok: "status" } });
    await t.server.close();
  });
});
