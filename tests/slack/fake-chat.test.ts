import { describe, expect, it } from "vitest";
import { ChatError } from "../../src/ports/chat.js";
import { FakeChat } from "../../src/slack/fake-chat.js";

describe("FakeChat", () => {
  it("records every call and hands out increasing ts values", async () => {
    const chat = new FakeChat();
    const a = await chat.post({ channel: "C1", text: "uno" });
    const b = await chat.post({ channel: "C1", text: "due", threadTs: a.ts });
    expect(a).toEqual({ ts: "1700000000.000001", channel: "C1" });
    expect(b.ts).toBe("1700000000.000002");
    await chat.createPrivateChannel("ceo");
    expect(chat.calls.map((c) => c.method)).toEqual(["post", "post", "createPrivateChannel"]);
    expect(chat.calls[1]?.args).toEqual({ channel: "C1", text: "due", threadTs: a.ts });
  });

  it("failNext throws the given error once, then works again", async () => {
    const chat = new FakeChat();
    chat.failNext("post", new ChatError("rate limited", "rate_limited", 1500));
    await expect(chat.post({ channel: "C1", text: "x" })).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 1500,
    });
    await expect(chat.post({ channel: "C1", text: "x" })).resolves.toBeTruthy();
  });

  it("refuses to update or delete a message posted with a persona", async () => {
    const chat = new FakeChat();
    const persona = await chat.post({ channel: "C1", text: "ciao", persona: { username: "Ada" } });
    const app = await chat.post({ channel: "C1", text: "card" });
    await expect(chat.update({ channel: "C1", ts: persona.ts, text: "x" })).rejects.toThrow(
      /persona message is immutable/,
    );
    await expect(chat.delete({ channel: "C1", ts: persona.ts })).rejects.toThrow(
      /persona message is immutable/,
    );
    await expect(chat.update({ channel: "C1", ts: app.ts, text: "y" })).resolves.toBeUndefined();
    await expect(chat.update({ channel: "C1", ts: "9.9", text: "y" })).rejects.toThrow(
      /unknown ts/,
    );
  });

  it("createPrivateChannel returns increasing ids and the other methods resolve", async () => {
    const chat = new FakeChat();
    const c1 = await chat.createPrivateChannel("ceo");
    const c2 = await chat.createPrivateChannel("agentopolis");
    expect(c1.id).not.toBe(c2.id);
    await chat.invite(c1.id, ["U1"]);
    await chat.setTopic(c1.id, "t");
    await chat.archive(c1.id);
    await chat.openModal("trig", { type: "modal" });
    await chat.updateModal("V1", { type: "modal" });
    await chat.publishHome("U1", { type: "home" });
    await chat.postEphemeral({ channel: c1.id, user: "U1", text: "solo per te" });
    await chat.upload({ channel: c1.id, filename: "a.txt", content: Buffer.from("a"), title: "a" });
    expect(chat.calls).toHaveLength(10);
  });

  it("refuses duplicate action_ids with invalid_blocks, in messages and views, like the real Slack", async () => {
    const chat = new FakeChat();
    const dup = [
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "answer" },
          { type: "button", action_id: "answer" },
        ],
      },
    ];
    await expect(chat.post({ channel: "C1", text: "x", blocks: dup })).rejects.toMatchObject({
      code: "invalid_blocks",
    });
    await expect(chat.publishHome("U1", { type: "home", blocks: dup })).rejects.toMatchObject({
      code: "invalid_blocks",
    });
    await expect(chat.openModal("T1", { type: "modal", blocks: dup })).rejects.toMatchObject({
      code: "invalid_blocks",
    });
    await expect(
      chat.post({
        channel: "C1",
        text: "x",
        blocks: [
          {
            type: "actions",
            elements: [
              { type: "button", action_id: "a:0" },
              { type: "button", action_id: "a:1" },
            ],
          },
        ],
      }),
    ).resolves.toBeTruthy();
  });
});
