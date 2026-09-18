import { beforeEach, describe, expect, it } from "vitest";
import { ChatError, type PostArgs } from "../../src/ports/chat.js";
import { FakeChat } from "../../src/slack/fake-chat.js";
import { postAsPersona, resetPersonaLevel } from "../../src/slack/persona.js";

const persona = { username: "Ada · CEO", iconUrl: "https://x/ada.png", iconEmoji: ":robot_face:" };
const personaOf = (chat: FakeChat, i: number) => {
  const call = chat.calls[i];
  if (!call) throw new Error(`no call ${i}`);
  return (call.args as PostArgs).persona;
};

describe("postAsPersona", () => {
  beforeEach(() => resetPersonaLevel());

  it("posts with username and icon_url when the scope allows", async () => {
    const chat = new FakeChat();
    await postAsPersona(chat, { channel: "C1", text: "ciao", persona });
    expect(chat.calls).toHaveLength(1);
    expect(personaOf(chat, 0)).toEqual({ username: persona.username, iconUrl: persona.iconUrl });
  });

  it("falls back icon_url → icon_emoji → username → plain on missing_scope, and remembers", async () => {
    const chat = new FakeChat();
    chat.failNext("post", new ChatError("missing_scope", "missing_scope"));
    await postAsPersona(chat, { channel: "C1", text: "uno", persona });
    expect(chat.calls).toHaveLength(2);
    expect(personaOf(chat, 1)).toEqual({
      username: persona.username,
      iconEmoji: persona.iconEmoji,
    });
    // the level is remembered: the next post starts at icon_emoji
    await postAsPersona(chat, { channel: "C1", text: "due", persona });
    expect(chat.calls).toHaveLength(3);
    expect(personaOf(chat, 2)).toEqual({
      username: persona.username,
      iconEmoji: persona.iconEmoji,
    });
    // two more scope failures: bare username, then no persona at all
    chat.failNext("post", new ChatError("invalid_arguments", "invalid_arguments"));
    await postAsPersona(chat, { channel: "C1", text: "tre", persona });
    expect(personaOf(chat, 4)).toEqual({ username: persona.username });
    chat.failNext("post", new ChatError("missing_scope", "missing_scope"));
    const r = await postAsPersona(chat, { channel: "C1", text: "quattro", persona });
    expect(personaOf(chat, 6)).toBeUndefined();
    expect(r.ts).toBeTruthy();
  });

  it("skips levels the persona cannot fill (no icon_url given)", async () => {
    const chat = new FakeChat();
    await postAsPersona(chat, { channel: "C1", text: "x", persona: { username: "Leo" } });
    expect(personaOf(chat, 0)).toEqual({ username: "Leo" });
  });

  it("does not swallow other errors", async () => {
    const chat = new FakeChat();
    chat.failNext("post", new ChatError("channel_not_found", "channel_not_found"));
    await expect(postAsPersona(chat, { channel: "C9", text: "x", persona })).rejects.toMatchObject({
      code: "channel_not_found",
    });
    expect(chat.calls).toHaveLength(1);
  });

  it("gives up with the last error when even the plain post fails on scope", async () => {
    const chat = new FakeChat();
    resetPersonaLevel("plain");
    chat.failNext("post", new ChatError("missing_scope", "missing_scope"));
    await expect(postAsPersona(chat, { channel: "C1", text: "x", persona })).rejects.toMatchObject({
      code: "missing_scope",
    });
  });
});
