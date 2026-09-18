import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import {
  TOOL_NAMES,
  type ToolContext,
  type ToolHandlers,
  type ToolName,
  validateInput,
} from "./tools.js";

export type ToolSocketOptions = {
  path: string;
  tokens: Map<string, ToolContext>;
  handlers: ToolHandlers;
};

export type ToolSocket = { close(): Promise<void> };

const send = (socket: Socket, obj: unknown) => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(obj)}\n`);
};

/**
 * Daemon side of the per-turn tool channel: a unix socket speaking JSON lines. The first
 * line must be {"hello":{"token"}}; an unknown token closes the connection. Then each
 * {"id","tool","input"} gets {"id","result"} or {"id","error"}.
 */
export function startToolSocket(opts: ToolSocketOptions): Promise<ToolSocket> {
  const server: Server = createServer((socket) => {
    let ctx: ToolContext | undefined;
    const rl = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    rl.on("line", (line) => {
      let msg: { hello?: { token?: string }; id?: unknown; tool?: unknown; input?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        send(socket, { error: "bad json" });
        socket.destroy();
        return;
      }
      if (!ctx) {
        const token = msg.hello?.token;
        const found = token ? opts.tokens.get(token) : undefined;
        if (!found) {
          send(socket, { error: "unknown token" });
          socket.destroy();
          return;
        }
        ctx = found;
        send(socket, { hello: "ok", agent: ctx.agent, turnId: ctx.turnId });
        return;
      }
      const id = msg.id;
      const tool = msg.tool;
      if (typeof tool !== "string" || !TOOL_NAMES.includes(tool as ToolName)) {
        send(socket, { id, error: `unknown tool ${String(tool)}` });
        return;
      }
      const context = ctx;
      void (async () => {
        try {
          const input = validateInput(tool as ToolName, msg.input);
          const result = await opts.handlers[tool as ToolName](context, input);
          send(socket, { id, result: result ?? null });
        } catch (e) {
          send(socket, { id, error: (e as Error).message });
        }
      })();
    });
    socket.on("error", () => {
      // a client that vanished mid-call is the turn's problem, not the daemon's
    });
  });
  const sockets = new Set<Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.path, () => {
      server.off("error", reject);
      resolve({
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
