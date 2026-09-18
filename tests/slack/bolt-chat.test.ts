import { describe, expect, it } from "vitest";
import { ChatError } from "../../src/ports/chat.js";
import {
  BoltChat,
  CLIENT_OPTIONS,
  type SlackClient,
  toChatError,
} from "../../src/slack/bolt-chat.js";

function stub() {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  let fail: unknown;
  const m = (method: string) => async (args: Record<string, unknown>) => {
    calls.push({ method, args });
    if (fail) {
      const e = fail;
      fail = undefined;
      throw e;
    }
    return {
      ok: true,
      ts: "1.2",
      channel: args.channel ?? "C1",
      ...(method === "conversations.create" ? { channel: { id: "CNEW" } } : {}),
    };
  };
  const client: SlackClient = {
    chat: {
      postMessage: m("chat.postMessage"),
      update: m("chat.update"),
      delete: m("chat.delete"),
      postEphemeral: m("chat.postEphemeral"),
    },
    conversations: {
      list: async (args: Record<string, unknown>) => {
        calls.push({ method: "conversations.list", args });
        return args.cursor
          ? {
              ok: true,
              channels: [{ id: "C2", name: "beta" }],
              response_metadata: { next_cursor: "" },
            }
          : {
              ok: true,
              channels: [{ id: "C1", name: "alpha" }],
              response_metadata: { next_cursor: "page2" },
            };
      },
      create: m("conversations.create"),
      invite: m("conversations.invite"),
      archive: m("conversations.archive"),
      setTopic: m("conversations.setTopic"),
    },
    views: { open: m("views.open"), update: m("views.update"), publish: m("views.publish") },
    files: { uploadV2: m("files.uploadV2") },
    agents: {
      sessions: { setStatus: m("agents.sessions.setStatus"), rename: m("agents.sessions.rename") },
    },
  };
  return {
    client,
    calls,
    failNext: (e: unknown) => {
      fail = e;
    },
  };
}

describe("BoltChat", () => {
  it("is built with bounded retries and a per-request timeout", () => {
    expect(CLIENT_OPTIONS).toEqual({
      retryConfig: { retries: 2, factor: 2, minTimeout: 500 },
      timeout: 10_000,
    });
  });

  it("posts with persona identity fields, thread_ts as a string, and the text fallback", async () => {
    const s = stub();
    const chat = new BoltChat(s.client);
    const r = await chat.post({
      channel: "C1",
      text: "ciao",
      blocks: [{ type: "divider" }],
      threadTs: "1700.000100",
      persona: { username: "Ada", iconUrl: "https://x/a.png" },
      mention: "U1",
    });
    expect(r).toEqual({ ts: "1.2", channel: "C1" });
    expect(s.calls[0]?.args).toEqual({
      channel: "C1",
      text: "<@U1> ciao",
      blocks: [{ type: "divider" }],
      thread_ts: "1700.000100",
      username: "Ada",
      icon_url: "https://x/a.png",
    });
    expect(typeof s.calls[0]?.args.thread_ts).toBe("string");
  });

  it("update never carries identity fields", async () => {
    const s = stub();
    await new BoltChat(s.client).update({ channel: "C1", ts: "1.2", text: "done", blocks: [] });
    const keys = Object.keys(s.calls[0]?.args ?? {});
    expect(keys).toEqual(["channel", "ts", "text", "blocks"]);
  });

  it("maps the SDK's error shapes to ChatError codes and retry-after", async () => {
    expect(
      toChatError({ code: "slack_webapi_platform_error", data: { error: "channel_not_found" } }),
    ).toMatchObject({ code: "channel_not_found" });
    expect(toChatError({ code: "slack_webapi_rate_limited_error", retryAfter: 30 })).toMatchObject({
      code: "ratelimited",
      retryAfterMs: 30_000,
    });
    expect(
      toChatError({
        code: "slack_webapi_http_error",
        statusCode: 503,
        headers: { "retry-after": "7" },
      }),
    ).toMatchObject({ code: "http_503", retryAfterMs: 7_000 });
    expect(
      toChatError({ code: "slack_webapi_request_error", message: "socket hang up" }),
    ).toMatchObject({ code: "request_error" });
    expect(toChatError(new Error("boom"))).toMatchObject({ code: "unknown", message: "boom" });
    const s = stub();
    s.failNext({ code: "slack_webapi_platform_error", data: { error: "missing_scope" } });
    await expect(new BoltChat(s.client).post({ channel: "C1", text: "x" })).rejects.toBeInstanceOf(
      ChatError,
    );
  });

  it("wraps channels, modals, home, sessions and uploads with Slack's argument names", async () => {
    const s = stub();
    const chat = new BoltChat(s.client);
    expect(await chat.createPrivateChannel("ceo")).toEqual({ id: "CNEW" });
    await chat.invite("C1", ["U1", "U2"]);
    await chat.setTopic("C1", "topic");
    await chat.archive("C1");
    await chat.openModal("T1", { type: "modal" });
    await chat.updateModal("V1", { type: "modal" });
    await chat.publishHome("U1", { type: "home" });
    await chat.setSessionStatus({
      channel: "C1",
      threadTs: "1.1",
      status: "processing",
      persona: { username: "Leo" },
    });
    await chat.renameSession({ channel: "C1", threadTs: "1.1", title: "Fix login" });
    await chat.upload({
      channel: "C1",
      threadTs: "1.1",
      filename: "r.md",
      content: Buffer.from("x"),
      title: "Report",
    });
    expect(s.calls.map((c) => c.method)).toEqual([
      "conversations.create",
      "conversations.invite",
      "conversations.setTopic",
      "conversations.archive",
      "views.open",
      "views.update",
      "views.publish",
      "agents.sessions.setStatus",
      "agents.sessions.rename",
      "files.uploadV2",
    ]);
    expect(s.calls[0]?.args).toEqual({ name: "ceo", is_private: true });
    expect(s.calls[1]?.args).toEqual({ channel: "C1", users: "U1,U2" });
    expect(s.calls[6]?.args).toEqual({ user_id: "U1", view: { type: "home" } });
    expect(s.calls[7]?.args).toEqual({
      channel_id: "C1",
      status: "processing",
      thread_ts: "1.1",
      username: "Leo",
    });
    expect(s.calls[9]?.args).toMatchObject({
      channel_id: "C1",
      thread_ts: "1.1",
      filename: "r.md",
      title: "Report",
    });
  });

  it("lists private channels across pages", async () => {
    const s = stub();
    const list = await new BoltChat(s.client).listPrivateChannels();
    expect(list).toEqual([
      { id: "C1", name: "alpha" },
      { id: "C2", name: "beta" },
    ]);
    const args = s.calls.filter((c) => c.method === "conversations.list").map((c) => c.args);
    expect(args[0]).toMatchObject({ types: "private_channel", exclude_archived: true, limit: 200 });
    expect(args[1]).toMatchObject({ cursor: "page2" });
  });
});
