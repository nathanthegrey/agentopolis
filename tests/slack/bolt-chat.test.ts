import { describe, expect, it } from "vitest";
import { ChatError } from "../../src/ports/chat.js";
import {
  BoltChat,
  CLIENT_OPTIONS,
  type SlackClient,
  toChatError,
} from "../../src/slack/bolt-chat.js";

function stubClient(app: string) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  let fail: unknown;
  const m =
    (method: string) =>
    async (args: Record<string, unknown> = {}) => {
      calls.push({ method, args });
      if (fail) {
        const e = fail;
        fail = undefined;
        throw e;
      }
      if (method === "conversations.create") return { ok: true, channel: { id: `CNEW_${app}` } };
      if (method === "conversations.open")
        return { ok: true, channel: { id: `D_${app}_${String(args.users)}` } };
      if (method === "auth.test") return { ok: true, user_id: `UB_${app}`, bot_id: `B_${app}` };
      if (method === "conversations.list") {
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
      }
      return { ok: true, ts: "1.2", channel: args.channel ?? "C1" };
    };
  const client: SlackClient = {
    auth: { test: m("auth.test") },
    chat: {
      postMessage: m("chat.postMessage"),
      update: m("chat.update"),
      delete: m("chat.delete"),
      postEphemeral: m("chat.postEphemeral"),
    },
    conversations: {
      list: m("conversations.list"),
      open: m("conversations.open"),
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
function stub(now?: () => number) {
  const company = stubClient("company");
  const ada = stubClient("ada");
  const chat = new BoltChat({ company: company.client, ada: ada.client }, now ? { now } : {});
  return { chat, company, ada };
}

describe("BoltChat", () => {
  it("is built with bounded retries and a per-request timeout, and needs a company app", () => {
    expect(CLIENT_OPTIONS).toEqual({
      retryConfig: { retries: 2, factor: 2, minTimeout: 500 },
      timeout: 10_000,
    });
    expect(() => new BoltChat({ ada: stubClient("ada").client })).toThrow(/company/);
  });

  it("routes each call to the app named by `as`, company by default; unknown app is a ChatError", async () => {
    const s = stub();
    await s.chat.post({ channel: "C1", text: "from company" });
    await s.chat.post({ channel: "D1", text: "from ada", as: "ada" });
    await s.chat.publishHome("U1", { type: "home" });
    await s.chat.setTopic("C1", "t", "ada");
    expect(s.company.calls.map((c) => c.method)).toEqual(["chat.postMessage", "views.publish"]);
    expect(s.ada.calls.map((c) => c.method)).toEqual([
      "chat.postMessage",
      "conversations.setTopic",
    ]);
    await expect(s.chat.post({ channel: "C1", text: "x", as: "penny" })).rejects.toMatchObject({
      code: "unknown_app",
    });
  });

  it("posts with persona identity fields, thread_ts as a string, and the text fallback", async () => {
    const s = stub();
    const r = await s.chat.post({
      channel: "C1",
      text: "ciao",
      blocks: [{ type: "divider" }],
      threadTs: "1700.000100",
      persona: { username: "Nina", iconUrl: "https://x/n.png" },
      mention: "U1",
      as: "ada",
    });
    expect(r).toEqual({ ts: "1.2", channel: "C1" });
    expect(s.ada.calls[0]?.args).toEqual({
      channel: "C1",
      text: "<@U1> ciao",
      blocks: [{ type: "divider" }],
      thread_ts: "1700.000100",
      username: "Nina",
      icon_url: "https://x/n.png",
    });
    expect(typeof s.ada.calls[0]?.args.thread_ts).toBe("string");
  });

  it("update never carries identity fields", async () => {
    const s = stub();
    await s.chat.update({ channel: "C1", ts: "1.2", text: "done", blocks: [] });
    expect(Object.keys(s.company.calls[0]?.args ?? {})).toEqual([
      "channel",
      "ts",
      "text",
      "blocks",
    ]);
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
    s.company.failNext({ code: "slack_webapi_platform_error", data: { error: "missing_scope" } });
    await expect(s.chat.post({ channel: "C1", text: "x" })).rejects.toBeInstanceOf(ChatError);
  });

  it("wraps channels, DMs, bot ids, modals, home, sessions and uploads with Slack's argument names", async () => {
    const s = stub();
    expect(await s.chat.createPrivateChannel("agentopolis-hq")).toEqual({ id: "CNEW_company" });
    expect(await s.chat.openDm("U1", "ada")).toEqual({ id: "D_ada_U1" });
    expect(await s.chat.botUserId("ada")).toBe("UB_ada");
    expect(await s.chat.botUserId("ada")).toBe("UB_ada"); // cached: one auth.test
    await s.chat.invite("C1", ["U1", "UB_ada"]);
    await s.chat.archive("C1");
    await s.chat.openModal("T1", { type: "modal" });
    await s.chat.updateModal("V1", { type: "modal" });
    await s.chat.setSessionStatus({
      channel: "C1",
      threadTs: "1.1",
      status: "processing",
      persona: { username: "Nina" },
      as: "ada",
    });
    await s.chat.renameSession({ channel: "C1", threadTs: "1.1", title: "Fix login", as: "ada" });
    await s.chat.upload({
      channel: "C1",
      threadTs: "1.1",
      filename: "r.md",
      content: Buffer.from("x"),
      title: "Report",
    });
    expect(s.company.calls.map((c) => c.method)).toEqual([
      "conversations.create",
      "conversations.invite",
      "conversations.archive",
      "views.open",
      "views.update",
      "files.uploadV2",
    ]);
    expect(s.ada.calls.map((c) => c.method)).toEqual([
      "conversations.open",
      "auth.test",
      "agents.sessions.setStatus",
      "agents.sessions.rename",
    ]);
    expect(s.company.calls[0]?.args).toEqual({ name: "agentopolis-hq", is_private: true });
    expect(s.ada.calls[0]?.args).toEqual({ users: "U1" });
    expect(s.company.calls[1]?.args).toEqual({ channel: "C1", users: "U1,UB_ada" });
    expect(s.ada.calls[2]?.args).toEqual({
      channel_id: "C1",
      status: "processing",
      thread_ts: "1.1",
      username: "Nina",
    });
  });

  it("lists private channels across pages", async () => {
    const s = stub();
    const list = await s.chat.listPrivateChannels();
    expect(list).toEqual([
      { id: "C1", name: "alpha" },
      { id: "C2", name: "beta" },
    ]);
    const args = s.company.calls
      .filter((c) => c.method === "conversations.list")
      .map((c) => c.args);
    expect(args[0]).toMatchObject({ types: "private_channel", exclude_archived: true, limit: 200 });
    expect(args[1]).toMatchObject({ cursor: "page2" });
  });

  it("enforces the per-method budget table per app: chat.update 50/min, conversations.* 40/min, with a retry-after", async () => {
    let t = 1_000_000;
    const s = stub(() => t);
    for (let i = 0; i < 50; i += 1)
      await s.chat.update({ channel: "C1", ts: "1.2", text: `n${i}` });
    await expect(s.chat.update({ channel: "C1", ts: "1.2", text: "51" })).rejects.toMatchObject({
      code: "ratelimited",
    });
    const err = (await s.chat
      .update({ channel: "C1", ts: "1.2", text: "51" })
      .catch((e: ChatError) => e)) as ChatError;
    expect(err.retryAfterMs ?? 0).toBeGreaterThan(0);
    expect(err.retryAfterMs ?? 0).toBeLessThanOrEqual(60_000);
    expect(s.company.calls.filter((c) => c.method === "chat.update")).toHaveLength(50); // nothing sent past the budget
    await s.chat.update({ channel: "D1", ts: "1.2", text: "ada has her own budget", as: "ada" }); // per app
    for (let i = 0; i < 38; i += 1) await s.chat.createPrivateChannel(`c${i}`);
    await s.chat.listPrivateChannels(); // two pages: the 39th and 40th conversations.* calls of the minute
    await expect(s.chat.archive("C1")).rejects.toMatchObject({ code: "ratelimited" });
    t += 60_000;
    await s.chat.update({ channel: "C1", ts: "1.2", text: "a minute later" });
    await s.chat.archive("C1");
    await s.chat.post({ channel: "C1", text: "postMessage is not budgeted here" });
  });
});
