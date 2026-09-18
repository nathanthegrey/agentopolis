export type Blocks = unknown[];
export type Persona = { username: string; iconUrl?: string; iconEmoji?: string };
export type PostArgs = {
  channel: string;
  text: string;
  blocks?: Blocks;
  threadTs?: string;
  persona?: Persona;
  /** a Slack user id to mention (<@id>) at the start of the text */
  mention?: string;
};
export type Posted = { ts: string; channel: string };

export interface Chat {
  post(args: PostArgs): Promise<Posted>;
  update(args: { channel: string; ts: string; text: string; blocks?: Blocks }): Promise<void>;
  delete(args: { channel: string; ts: string }): Promise<void>;
  postEphemeral(args: {
    channel: string;
    user: string;
    text: string;
    blocks?: Blocks;
  }): Promise<void>;
  createPrivateChannel(name: string): Promise<{ id: string }>;
  invite(channel: string, users: string[]): Promise<void>;
  archive(channel: string): Promise<void>;
  setTopic(channel: string, topic: string): Promise<void>;
  openModal(triggerId: string, view: unknown): Promise<void>;
  updateModal(viewId: string, view: unknown): Promise<void>;
  publishHome(user: string, view: unknown): Promise<void>;
  setSessionStatus?(args: {
    channel: string;
    threadTs?: string;
    status: "active" | "processing";
    persona?: Persona;
  }): Promise<void>;
  upload(args: {
    channel: string;
    threadTs?: string;
    filename: string;
    content: Buffer;
    title: string;
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
