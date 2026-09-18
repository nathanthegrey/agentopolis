export type Blocks = unknown[];
export type Persona = { username: string; iconUrl?: string; iconEmoji?: string };
/** the Slack app that performs a call: a key of config.slack.apps; "company" by default */
export type AppName = string;
export const COMPANY_APP: AppName = "company";

export type PostArgs = {
  channel: string;
  text: string;
  blocks?: Blocks;
  threadTs?: string;
  persona?: Persona;
  /** a Slack user id to mention (<@id>) at the start of the text */
  mention?: string;
  as?: AppName;
};
export type Posted = { ts: string; channel: string };

export interface Chat {
  post(args: PostArgs): Promise<Posted>;
  update(args: {
    channel: string;
    ts: string;
    text: string;
    blocks?: Blocks;
    as?: AppName;
  }): Promise<void>;
  delete(args: { channel: string; ts: string; as?: AppName }): Promise<void>;
  postEphemeral(args: {
    channel: string;
    user: string;
    text: string;
    blocks?: Blocks;
    as?: AppName;
  }): Promise<void>;
  createPrivateChannel(name: string, as?: AppName): Promise<{ id: string }>;
  /** every private channel the app can see (conversations.list), for bootstrap adoption */
  listPrivateChannels(as?: AppName): Promise<{ id: string; name: string }[]>;
  /** the app's direct message with a user (conversations.open); the id is stable */
  openDm(userId: string, as?: AppName): Promise<{ id: string }>;
  /** the app's own bot user id (auth.test), needed to invite one app into another's channel */
  botUserId(as?: AppName): Promise<string>;
  invite(channel: string, users: string[], as?: AppName): Promise<void>;
  archive(channel: string, as?: AppName): Promise<void>;
  setTopic(channel: string, topic: string, as?: AppName): Promise<void>;
  openModal(triggerId: string, view: unknown, as?: AppName): Promise<void>;
  updateModal(viewId: string, view: unknown, as?: AppName): Promise<void>;
  publishHome(user: string, view: unknown, as?: AppName): Promise<void>;
  setSessionStatus?(args: {
    channel: string;
    threadTs?: string;
    status: "active" | "processing";
    persona?: Persona;
    as?: AppName;
  }): Promise<void>;
  upload(args: {
    channel: string;
    threadTs?: string;
    filename: string;
    content: Buffer;
    title: string;
    as?: AppName;
  }): Promise<void>;
}

/** Every Slack failure reaches callers as a ChatError with the Slack error code. */
export class ChatError extends Error {
  readonly code: string;
  readonly retryAfterMs: number | undefined;
  constructor(message: string, code: string, retryAfterMs?: number) {
    super(message);
    this.name = "ChatError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
