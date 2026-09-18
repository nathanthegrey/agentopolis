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
import { assertUniqueIds, assertValues, EmptyValueError } from "./limits.js";

export type RecordedCall = { method: keyof Chat; args: unknown };

/**
 * what the real Slack refuses: duplicate action_ids / block_ids (invalid_blocks) and an
 * empty `value` on a button or option (invalid_arguments)
 */
function refuseInvalidBlocks(blocks: unknown): void {
  if (!Array.isArray(blocks)) return;
  try {
    assertUniqueIds(blocks);
    assertValues(blocks);
  } catch (e) {
    if (e instanceof EmptyValueError) {
      throw new ChatError(`invalid_arguments: ${e.message}`, "invalid_arguments");
    }
    throw new ChatError(`invalid_blocks: ${(e as Error).message}`, "invalid_blocks");
  }
}
const viewBlocks = (view: unknown) => (view as { blocks?: unknown } | null)?.blocks;

/**
 * The permanent fake for the Chat port: records every call (with the app it was made `as`),
 * hands out increasing ts values, can fail the next call of a method once, refuses what
 * Slack refuses (duplicate ids, a taken channel name), and enforces the one rule the real
 * Slack cannot enforce for us: a message posted with a persona is never updated or deleted.
 */
export class FakeChat implements Chat {
  readonly calls: RecordedCall[] = [];
  readonly posted = new Map<
    string,
    { channel: string; persona: Persona | undefined; as: AppName; args: PostArgs }
  >();
  readonly channels = new Map<string, string>(); // name → id, created through this fake
  /** channels that "already exist" in the workspace before the test starts */
  readonly preexisting: { id: string; name: string }[];
  readonly dms = new Map<string, string>(); // `${app}:${user}` → id
  #ts = 0;
  #channelSeq = 0;
  #dmSeq = 0;
  readonly #failures = new Map<keyof Chat, ChatError>();

  constructor(opts: { preexisting?: { id: string; name: string }[] } = {}) {
    this.preexisting = [...(opts.preexisting ?? [])];
  }

  failNext(method: keyof Chat, error: ChatError): void {
    this.#failures.set(method, error);
  }

  #record(method: keyof Chat, args: unknown): void {
    this.calls.push({ method, args });
    const failure = this.#failures.get(method);
    if (failure) {
      this.#failures.delete(method);
      throw failure;
    }
  }

  nextTs(): string {
    this.#ts += 1;
    return `1700000000.${String(this.#ts).padStart(6, "0")}`;
  }

  async post(args: PostArgs): Promise<Posted> {
    this.#record("post", args);
    refuseInvalidBlocks(args.blocks);
    const ts = this.nextTs();
    this.posted.set(ts, {
      channel: args.channel,
      persona: args.persona,
      as: args.as ?? COMPANY_APP,
      args,
    });
    return { ts, channel: args.channel };
  }

  #assertMutable(ts: string): void {
    const p = this.posted.get(ts);
    if (!p) throw new Error(`FakeChat: unknown ts ${ts}`);
    if (p.persona) throw new Error(`FakeChat: persona message is immutable (ts ${ts})`);
  }

  async update(args: {
    channel: string;
    ts: string;
    text: string;
    blocks?: Blocks;
    as?: AppName;
  }): Promise<void> {
    this.#record("update", args);
    refuseInvalidBlocks(args.blocks);
    this.#assertMutable(args.ts);
  }

  async delete(args: { channel: string; ts: string; as?: AppName }): Promise<void> {
    this.#record("delete", args);
    this.#assertMutable(args.ts);
    this.posted.delete(args.ts);
  }

  async postEphemeral(args: {
    channel: string;
    user: string;
    text: string;
    blocks?: Blocks;
    as?: AppName;
  }): Promise<void> {
    this.#record("postEphemeral", args);
  }

  async createPrivateChannel(name: string, as: AppName = COMPANY_APP): Promise<{ id: string }> {
    this.#record("createPrivateChannel", { name, as });
    if (this.channels.has(name) || this.preexisting.some((c) => c.name === name)) {
      throw new ChatError("name_taken", "name_taken");
    }
    this.#channelSeq += 1;
    const id = `C${String(this.#channelSeq).padStart(3, "0")}`;
    this.channels.set(name, id);
    return { id };
  }

  async listPrivateChannels(as: AppName = COMPANY_APP): Promise<{ id: string; name: string }[]> {
    this.#record("listPrivateChannels", { as });
    return [...this.preexisting, ...[...this.channels].map(([name, id]) => ({ id, name }))];
  }

  async openDm(userId: string, as: AppName = COMPANY_APP): Promise<{ id: string }> {
    this.#record("openDm", { userId, as });
    const key = `${as}:${userId}`;
    const existing = this.dms.get(key);
    if (existing) return { id: existing };
    this.#dmSeq += 1;
    const id = `D${String(this.#dmSeq).padStart(3, "0")}`;
    this.dms.set(key, id);
    return { id };
  }

  async botUserId(as: AppName = COMPANY_APP): Promise<string> {
    this.#record("botUserId", { as });
    return `UB_${as.toUpperCase()}`;
  }

  async invite(channel: string, users: string[], as: AppName = COMPANY_APP): Promise<void> {
    this.#record("invite", { channel, users, as });
  }

  async archive(channel: string, as: AppName = COMPANY_APP): Promise<void> {
    this.#record("archive", { channel, as });
  }

  async setTopic(channel: string, topic: string, as: AppName = COMPANY_APP): Promise<void> {
    this.#record("setTopic", { channel, topic, as });
  }

  async openModal(triggerId: string, view: unknown, as: AppName = COMPANY_APP): Promise<void> {
    this.#record("openModal", { triggerId, view, as });
    refuseInvalidBlocks(viewBlocks(view));
  }

  async updateModal(viewId: string, view: unknown, as: AppName = COMPANY_APP): Promise<void> {
    this.#record("updateModal", { viewId, view, as });
    refuseInvalidBlocks(viewBlocks(view));
  }

  async publishHome(user: string, view: unknown, as: AppName = COMPANY_APP): Promise<void> {
    this.#record("publishHome", { user, view, as });
    refuseInvalidBlocks(viewBlocks(view));
  }

  async setSessionStatus(args: {
    channel: string;
    threadTs?: string;
    status: "active" | "processing";
    persona?: Persona;
    as?: AppName;
  }): Promise<void> {
    this.#record("setSessionStatus", args);
  }

  async upload(args: {
    channel: string;
    threadTs?: string;
    filename: string;
    content: Buffer;
    title: string;
    as?: AppName;
  }): Promise<void> {
    this.#record("upload", { ...args, content: `<${args.content.length} bytes>` });
  }
}
