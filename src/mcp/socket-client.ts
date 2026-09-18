import { connect } from "node:net";
import { createInterface } from "node:readline";

/** One call over the daemon socket: hello with the token, one request, one response. */
export function callDaemon(
  socketPath: string,
  token: string,
  tool: string,
  input: unknown,
  timeoutMs = 30_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const rl = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`daemon did not answer ${tool} within ${timeoutMs} ms`));
    }, timeoutMs);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      socket.end();
      fn();
    };
    let greeted = false;
    socket.on("connect", () => socket.write(`${JSON.stringify({ hello: { token } })}\n`));
    socket.on("error", (e) => finish(() => reject(e)));
    socket.on("close", () => finish(() => reject(new Error("daemon closed the connection"))));
    rl.on("line", (line) => {
      let msg: { hello?: string; error?: string; result?: unknown; id?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        return finish(() => reject(new Error("daemon sent bad json")));
      }
      if (!greeted) {
        if (msg.hello !== "ok")
          return finish(() => reject(new Error(msg.error ?? "hello refused")));
        greeted = true;
        socket.write(`${JSON.stringify({ id: 1, tool, input })}\n`);
        return;
      }
      if (msg.error !== undefined) return finish(() => reject(new Error(msg.error)));
      finish(() => resolve(msg.result));
    });
  });
}
