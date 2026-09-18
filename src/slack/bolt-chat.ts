// Chat over Slack's Web API (the client Bolt hands us). Personas ride on chat.postMessage's
// username/icon_url/icon_emoji; chat.update never carries identity fields. Every failure
// becomes a ChatError with the Slack error code and, when Slack says so, a retry-after.
import {
  type Blocks,
  type Chat,
  ChatError,
  type Persona,
  type PostArgs,
  type Posted,
} from "../ports/chat.js";

/** Bounded retries and a per-request timeout: the SDK default retries for ~30 minutes. */
export const CLIENT_OPTIONS = {
  retryConfig: { retries: 2, factor: 2, minTimeout: 500 },
  timeout: 10_000,
};

type Result = Promise<Record<string, unknown>>;
/** The slice of WebClient we call; the test injects a stub with the same shape. */
export type SlackClient = {
  chat: {
    postMessage(args: Record<string, unknown>): Result;
    update(args: Record<string, unknown>): Result;
    delete(args: Record<string, unknown>): Result;
    postEphemeral(args: Record<string, unknown>): Result;
  };
  conversations: {
    list(args: Record<string, unknown>): Result;
    create(args: Record<string, unknown>): Result;
    invite(args: Record<string, unknown>): Result;
    archive(args: Record<string, unknown>): Result;
    setTopic(args: Record<string, unknown>): Result;
  };
  views: {
    open(args: Record<string, unknown>): Result;
    update(args: Record<string, unknown>): Result;
    publish(args: Record<string, unknown>): Result;
  };
  files: { uploadV2(args: Record<string, unknown>): Result };
  agents?: {
    sessions: {
      setStatus(args: Record<string, unknown>): Result;
      rename(args: Record<string, unknown>): Result;
    };
  };
};

const identity = (p: Persona | undefined): Record<string, unknown> =>
  p
    ? {
        username: p.username,
        ...(p.iconUrl ? { icon_url: p.iconUrl } : {}),
        ...(p.iconEmoji ? { icon_emoji: p.iconEmoji } : {}),
      }
    : {};

/** Maps the Slack SDK's error shapes (duck-typed by `code`) to ChatError. */
export function toChatError(e: unknown): ChatError {
  if (e instanceof ChatError) return e;
  const err = e as {
    code?: string;
    message?: string;
    data?: { error?: string };
    retryAfter?: number;
    statusCode?: number;
    headers?: Record<string, string>;
  };
  switch (err.code) {
    case "slack_webapi_platform_error":
      return new ChatError(
        err.data?.error ?? "platform_error",
        err.data?.error ?? "platform_error",
      );
    case "slack_webapi_rate_limited_error":
      return new ChatError("ratelimited", "ratelimited", (err.retryAfter ?? 1) * 1000);
    case "slack_webapi_http_error": {
      const retry = Number(err.headers?.["retry-after"]);
      return new ChatError(
        `http ${err.statusCode}`,
        `http_${err.statusCode}`,
        Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
      );
    }
    case "slack_webapi_request_error":
      return new ChatError(err.message ?? "request_error", "request_error");
    default:
      return new ChatError(err.message ?? String(e), "unknown");
  }
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toChatError(e);
  }
}

export class BoltChat implements Chat {
  readonly #c: SlackClient;
  constructor(client: SlackClient) {
    this.#c = client;
  }

  async post(a: PostArgs): Promise<Posted> {
    const text = a.mention ? `<@${a.mention}> ${a.text}` : a.text;
    const r = await call(() =>
      this.#c.chat.postMessage({
        channel: a.channel,
        text,
        ...(a.blocks ? { blocks: a.blocks } : {}),
        ...(a.threadTs ? { thread_ts: a.threadTs } : {}),
        ...identity(a.persona),
      }),
    );
    return { ts: String(r.ts), channel: String(r.channel ?? a.channel) };
  }

  async update(a: { channel: string; ts: string; text: string; blocks?: Blocks }): Promise<void> {
    await call(() =>
      this.#c.chat.update({
        channel: a.channel,
        ts: a.ts,
        text: a.text,
        ...(a.blocks ? { blocks: a.blocks } : {}),
      }),
    );
  }

  async delete(a: { channel: string; ts: string }): Promise<void> {
    await call(() => this.#c.chat.delete({ channel: a.channel, ts: a.ts }));
  }

  async postEphemeral(a: {
    channel: string;
    user: string;
    text: string;
    blocks?: Blocks;
  }): Promise<void> {
    await call(() =>
      this.#c.chat.postEphemeral({
        channel: a.channel,
        user: a.user,
        text: a.text,
        ...(a.blocks ? { blocks: a.blocks } : {}),
      }),
    );
  }

  async createPrivateChannel(name: string): Promise<{ id: string }> {
    const r = await call(() => this.#c.conversations.create({ name, is_private: true }));
    return { id: String((r.channel as { id?: string } | undefined)?.id ?? "") };
  }

  async listPrivateChannels(): Promise<{ id: string; name: string }[]> {
    const out: { id: string; name: string }[] = [];
    let cursor: string | undefined;
    do {
      const r = await call(() =>
        this.#c.conversations.list({
          types: "private_channel",
          exclude_archived: true,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const c of (r.channels as { id?: string; name?: string }[] | undefined) ?? []) {
        if (c.id && c.name) out.push({ id: c.id, name: c.name });
      }
      const next = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
      cursor = next ? next : undefined;
    } while (cursor);
    return out;
  }

  async invite(channel: string, users: string[]): Promise<void> {
    await call(() => this.#c.conversations.invite({ channel, users: users.join(",") }));
  }

  async archive(channel: string): Promise<void> {
    await call(() => this.#c.conversations.archive({ channel }));
  }

  async setTopic(channel: string, topic: string): Promise<void> {
    await call(() => this.#c.conversations.setTopic({ channel, topic }));
  }

  async openModal(triggerId: string, view: unknown): Promise<void> {
    await call(() => this.#c.views.open({ trigger_id: triggerId, view }));
  }

  async updateModal(viewId: string, view: unknown): Promise<void> {
    await call(() => this.#c.views.update({ view_id: viewId, view }));
  }

  async publishHome(user: string, view: unknown): Promise<void> {
    await call(() => this.#c.views.publish({ user_id: user, view }));
  }

  async setSessionStatus(a: {
    channel: string;
    threadTs?: string;
    status: "active" | "processing";
    persona?: Persona;
  }): Promise<void> {
    if (!this.#c.agents)
      throw new ChatError("agents.sessions is not available in this client", "feature_disabled");
    await call(() =>
      (this.#c.agents as NonNullable<SlackClient["agents"]>).sessions.setStatus({
        channel_id: a.channel,
        status: a.status,
        ...(a.threadTs ? { thread_ts: a.threadTs } : {}),
        ...identity(a.persona),
      }),
    );
  }

  async renameSession(a: { channel: string; threadTs?: string; title: string }): Promise<void> {
    if (!this.#c.agents)
      throw new ChatError("agents.sessions is not available in this client", "feature_disabled");
    await call(() =>
      (this.#c.agents as NonNullable<SlackClient["agents"]>).sessions.rename({
        channel_id: a.channel,
        title: a.title,
        ...(a.threadTs ? { thread_ts: a.threadTs } : {}),
      }),
    );
  }

  async upload(a: {
    channel: string;
    threadTs?: string;
    filename: string;
    content: Buffer;
    title: string;
  }): Promise<void> {
    await call(() =>
      this.#c.files.uploadV2({
        channel_id: a.channel,
        ...(a.threadTs ? { thread_ts: a.threadTs } : {}),
        filename: a.filename,
        file: a.content,
        title: a.title,
      }),
    );
  }
}
