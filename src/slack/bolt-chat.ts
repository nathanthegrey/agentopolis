// Chat over Slack's Web API, one client per configured app (the clients Bolt hands us).
// `as` picks the app; "company" by default. Personas ride on chat.postMessage's
// username/icon_url/icon_emoji; chat.update never carries identity fields. Every failure
// becomes a ChatError with the Slack error code and, when Slack says so, a retry-after.
import {
  type AppName,
  type Blocks,
  type Chat,
  ChatError,
  COMPANY_APP,
  type Persona,
  type PostArgs,
  type Posted,
} from "../ports/chat.js";

/** Bounded retries and a per-request timeout: the SDK default retries for ~30 minutes. */
export const CLIENT_OPTIONS = {
  retryConfig: { retries: 2, factor: 2, minTimeout: 500 },
  timeout: 10_000,
} as const;

type Result = Promise<Record<string, unknown>>;
/** The slice of WebClient we call; the test injects a stub with the same shape. */
export type SlackClient = {
  auth: { test(args?: Record<string, unknown>): Result };
  chat: {
    postMessage(args: Record<string, unknown>): Result;
    update(args: Record<string, unknown>): Result;
    delete(args: Record<string, unknown>): Result;
    postEphemeral(args: Record<string, unknown>): Result;
  };
  conversations: {
    list(args: Record<string, unknown>): Result;
    open(args: Record<string, unknown>): Result;
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
  readonly #clients: Map<AppName, SlackClient>;
  readonly #botUserIds = new Map<AppName, string>();

  constructor(clients: Map<AppName, SlackClient> | Record<AppName, SlackClient>) {
    this.#clients = clients instanceof Map ? clients : new Map(Object.entries(clients));
    if (!this.#clients.has(COMPANY_APP))
      throw new ChatError(`no "${COMPANY_APP}" app configured`, "unknown_app");
  }

  get apps(): AppName[] {
    return [...this.#clients.keys()];
  }

  #c(as: AppName | undefined): SlackClient {
    const client = this.#clients.get(as ?? COMPANY_APP);
    if (!client) throw new ChatError(`unknown Slack app "${as}"`, "unknown_app");
    return client;
  }

  async post(a: PostArgs): Promise<Posted> {
    const c = this.#c(a.as);
    const text = a.mention ? `<@${a.mention}> ${a.text}` : a.text;
    const r = await call(() =>
      c.chat.postMessage({
        channel: a.channel,
        text,
        ...(a.blocks ? { blocks: a.blocks } : {}),
        ...(a.threadTs ? { thread_ts: a.threadTs } : {}),
        ...identity(a.persona),
      }),
    );
    return { ts: String(r.ts), channel: String(r.channel ?? a.channel) };
  }

  async update(a: {
    channel: string;
    ts: string;
    text: string;
    blocks?: Blocks;
    as?: AppName;
  }): Promise<void> {
    const c = this.#c(a.as);
    await call(() =>
      c.chat.update({
        channel: a.channel,
        ts: a.ts,
        text: a.text,
        ...(a.blocks ? { blocks: a.blocks } : {}),
      }),
    );
  }

  async delete(a: { channel: string; ts: string; as?: AppName }): Promise<void> {
    const c = this.#c(a.as);
    await call(() => c.chat.delete({ channel: a.channel, ts: a.ts }));
  }

  async postEphemeral(a: {
    channel: string;
    user: string;
    text: string;
    blocks?: Blocks;
    as?: AppName;
  }): Promise<void> {
    const c = this.#c(a.as);
    await call(() =>
      c.chat.postEphemeral({
        channel: a.channel,
        user: a.user,
        text: a.text,
        ...(a.blocks ? { blocks: a.blocks } : {}),
      }),
    );
  }

  async createPrivateChannel(name: string, as?: AppName): Promise<{ id: string }> {
    const c = this.#c(as);
    const r = await call(() => c.conversations.create({ name, is_private: true }));
    return { id: String((r.channel as { id?: string } | undefined)?.id ?? "") };
  }

  async listPrivateChannels(as?: AppName): Promise<{ id: string; name: string }[]> {
    const c = this.#c(as);
    const out: { id: string; name: string }[] = [];
    let cursor: string | undefined;
    do {
      const r = await call(() =>
        c.conversations.list({
          types: "private_channel",
          exclude_archived: true,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const ch of (r.channels as { id?: string; name?: string }[] | undefined) ?? []) {
        if (ch.id && ch.name) out.push({ id: ch.id, name: ch.name });
      }
      const next = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
      cursor = next ? next : undefined;
    } while (cursor);
    return out;
  }

  async openDm(userId: string, as?: AppName): Promise<{ id: string }> {
    const c = this.#c(as);
    const r = await call(() => c.conversations.open({ users: userId }));
    return { id: String((r.channel as { id?: string } | undefined)?.id ?? "") };
  }

  async botUserId(as?: AppName): Promise<string> {
    const app = as ?? COMPANY_APP;
    const cached = this.#botUserIds.get(app);
    if (cached) return cached;
    const c = this.#c(app);
    const r = await call(() => c.auth.test());
    const id = String(r.user_id ?? "");
    if (!id) throw new ChatError(`auth.test for "${app}" returned no user_id`, "auth_test");
    this.#botUserIds.set(app, id);
    return id;
  }

  async invite(channel: string, users: string[], as?: AppName): Promise<void> {
    const c = this.#c(as);
    await call(() => c.conversations.invite({ channel, users: users.join(",") }));
  }

  async archive(channel: string, as?: AppName): Promise<void> {
    const c = this.#c(as);
    await call(() => c.conversations.archive({ channel }));
  }

  async setTopic(channel: string, topic: string, as?: AppName): Promise<void> {
    const c = this.#c(as);
    await call(() => c.conversations.setTopic({ channel, topic }));
  }

  async openModal(triggerId: string, view: unknown, as?: AppName): Promise<void> {
    const c = this.#c(as);
    await call(() => c.views.open({ trigger_id: triggerId, view }));
  }

  async updateModal(viewId: string, view: unknown, as?: AppName): Promise<void> {
    const c = this.#c(as);
    await call(() => c.views.update({ view_id: viewId, view }));
  }

  async publishHome(user: string, view: unknown, as?: AppName): Promise<void> {
    const c = this.#c(as);
    await call(() => c.views.publish({ user_id: user, view }));
  }

  async setSessionStatus(a: {
    channel: string;
    threadTs?: string;
    status: "active" | "processing";
    persona?: Persona;
    as?: AppName;
  }): Promise<void> {
    const c = this.#c(a.as);
    if (!c.agents)
      throw new ChatError("agents.sessions is not available in this client", "feature_disabled");
    const agents = c.agents;
    await call(() =>
      agents.sessions.setStatus({
        channel_id: a.channel,
        status: a.status,
        ...(a.threadTs ? { thread_ts: a.threadTs } : {}),
        ...identity(a.persona),
      }),
    );
  }

  async renameSession(a: {
    channel: string;
    threadTs?: string;
    title: string;
    as?: AppName;
  }): Promise<void> {
    const c = this.#c(a.as);
    if (!c.agents)
      throw new ChatError("agents.sessions is not available in this client", "feature_disabled");
    const agents = c.agents;
    await call(() =>
      agents.sessions.rename({
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
    as?: AppName;
  }): Promise<void> {
    const c = this.#c(a.as);
    await call(() =>
      c.files.uploadV2({
        channel_id: a.channel,
        ...(a.threadTs ? { thread_ts: a.threadTs } : {}),
        filename: a.filename,
        file: a.content,
        title: a.title,
      }),
    );
  }
}
