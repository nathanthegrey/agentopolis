import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/ports/clock.js";
import {
  classifyEvent,
  handleAction,
  handleCommand,
  handleEvent,
  handleView,
} from "../../src/slack/inbox.js";
import { openDatabase } from "../../src/store/db.js";
import { markProcessed } from "../../src/store/inbox.js";
import { inbox } from "../../src/store/schema.js";

const OWNER = "U0123ABCD";
const fresh = () => ({
  db: openDatabase(join(mkdtempSync(join(tmpdir(), "inbox-")), "a.db")),
  clock: new FakeClock(5_000_000),
});
const message = (over: Record<string, unknown> = {}, eventId = "Ev1") => ({
  event_id: eventId,
  event: { type: "message", channel: "C1", user: OWNER, text: "ciao", ts: "1700.1", ...over },
});

describe("classifyEvent", () => {
  it("recognises owner messages, threads, reactions, home, archive, joins", () => {
    expect(classifyEvent(message().event, OWNER)).toEqual({
      kind: "owner_message",
      channel: "C1",
      threadTs: undefined,
      text: "ciao",
      ts: "1700.1",
      user: OWNER,
    });
    expect(classifyEvent(message({ thread_ts: "1699.9" }).event, OWNER)).toMatchObject({
      kind: "owner_message",
      threadTs: "1699.9",
    });
    expect(
      classifyEvent(
        {
          type: "reaction_added",
          user: OWNER,
          reaction: "eyes",
          item: { channel: "C1", ts: "1700.1" },
        },
        OWNER,
      ),
    ).toEqual({ kind: "owner_reaction", channel: "C1", ts: "1700.1", reaction: "eyes" });
    expect(classifyEvent({ type: "app_home_opened", user: OWNER, tab: "home" }, OWNER)).toEqual({
      kind: "home_opened",
      user: OWNER,
    });
    expect(classifyEvent({ type: "channel_archive", channel: "C1", user: OWNER }, OWNER)).toEqual({
      kind: "channel_archived",
      channel: "C1",
    });
    expect(
      classifyEvent({ type: "member_joined_channel", channel: "C1", user: "U9" }, OWNER),
    ).toEqual({ kind: "member_joined", channel: "C1", user: "U9" });
  });
  it("drops bot-authored messages and ignores other users, edits, deletions and unknown types", () => {
    expect(classifyEvent(message({ bot_id: "B1" }).event, OWNER)).toEqual({
      kind: "bot_message_dropped",
    });
    expect(classifyEvent(message({ subtype: "bot_message" }).event, OWNER)).toEqual({
      kind: "bot_message_dropped",
    });
    expect(classifyEvent(message({ user: "U9" }).event, OWNER)).toEqual({
      kind: "ignored",
      reason: "not the owner",
    });
    expect(classifyEvent(message({ subtype: "message_changed" }).event, OWNER)).toMatchObject({
      kind: "ignored",
    });
    expect(classifyEvent(message({ subtype: "message_deleted" }).event, OWNER)).toMatchObject({
      kind: "ignored",
    });
    expect(classifyEvent({ type: "pin_added" }, OWNER)).toMatchObject({ kind: "ignored" });
  });
});

describe("handleEvent", () => {
  it("writes the row first, then classifies; twin deliveries with different ids dedupe on channel:ts", () => {
    const { db, clock } = fresh();
    const a = handleEvent(db, clock, OWNER, message({}, "Ev1"));
    expect(a.inserted).toBe(true);
    expect(a.inbound.kind).toBe("owner_message");
    const b = handleEvent(db, clock, OWNER, message({}, "Ev2"));
    expect(b.inserted).toBe(false);
    const c = handleEvent(db, clock, OWNER, message({}, "Ev1"));
    expect(c.inserted).toBe(false);
    const rows = db.orm.select().from(inbox).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.logicalKey).toBe("C1:1700.1");
    db.close();
  });
  it("a bot message is dropped and still deduped; markProcessed stamps the row", () => {
    const { db, clock } = fresh();
    const a = handleEvent(db, clock, OWNER, message({ bot_id: "B1" }, "Ev5"));
    expect(a.inserted).toBe(true);
    expect(a.inbound.kind).toBe("bot_message_dropped");
    expect(handleEvent(db, clock, OWNER, message({ bot_id: "B1" }, "Ev5")).inserted).toBe(false);
    clock.advance(10);
    markProcessed(db.orm, a.id, clock.now());
    expect(db.orm.select().from(inbox).all()[0]?.processedAt).toBe(clock.now());
    db.close();
  });
});

describe("handleAction / handleView / handleCommand", () => {
  it("parses a button click with render id and epoch from the value", () => {
    const { db, clock } = fresh();
    const r = handleAction(db, clock, {
      type: "block_actions",
      trigger_id: "T1",
      user: { id: OWNER },
      container: { channel_id: "C1", message_ts: "1700.2" },
      actions: [
        { action_id: "approve", value: "9:2", block_id: "approval:9", action_ts: "1700.3" },
      ],
    });
    expect(r.inserted).toBe(true);
    expect(r.inbound).toEqual({
      kind: "button",
      actionId: "approve",
      value: "9:2",
      renderId: 9,
      epoch: 2,
      selected: undefined,
      user: OWNER,
      channel: "C1",
      ts: "1700.2",
      triggerId: "T1",
    });
    expect(
      handleAction(db, clock, {
        type: "block_actions",
        trigger_id: "T1",
        user: { id: OWNER },
        actions: [{ action_id: "approve", value: "9:2" }],
      }).inserted,
    ).toBe(false);
    db.close();
  });
  it("parses a static_select choice and an overflow menu", () => {
    const { db, clock } = fresh();
    const sel = handleAction(db, clock, {
      type: "block_actions",
      trigger_id: "T2",
      user: { id: OWNER },
      actions: [{ action_id: "answer_select", selected_option: { value: "7:3" } }],
    });
    expect(sel.inbound).toMatchObject({
      kind: "button",
      actionId: "answer_select",
      value: "7:3",
      renderId: 7,
      selected: "7:3",
    });
    const menu = handleAction(db, clock, {
      type: "block_actions",
      trigger_id: "T3",
      user: { id: OWNER },
      actions: [{ action_id: "agent_menu", selected_option: { value: "pause:leo" } }],
    });
    expect(menu.inbound).toMatchObject({
      kind: "button",
      actionId: "agent_menu",
      value: "pause:leo",
      renderId: undefined,
    });
    db.close();
  });
  it("parses a view submission with its metadata and flattened values", () => {
    const { db, clock } = fresh();
    const r = handleView(db, clock, {
      type: "view_submission",
      trigger_id: "T4",
      user: { id: OWNER },
      view: {
        id: "V1",
        callback_id: "hire",
        private_metadata: "{}",
        state: {
          values: {
            role: { role: { type: "static_select", selected_option: { value: "lead" } } },
            display: { display: { type: "plain_text_input", value: "Leo" } },
            budget: { budget: { type: "plain_text_input", value: null } },
          },
        },
      },
    });
    expect(r.inbound).toEqual({
      kind: "view_submitted",
      callbackId: "hire",
      viewId: "V1",
      metadata: {},
      values: { role: "lead", display: "Leo", budget: null },
      user: OWNER,
      triggerId: "T4",
    });
    db.close();
  });
  it("parses a slash command", () => {
    const { db, clock } = fresh();
    const r = handleCommand(db, clock, {
      command: "/edit",
      text: "  leo  ",
      channel_id: "C1",
      user_id: OWNER,
      trigger_id: "T5",
    });
    expect(r.inbound).toEqual({
      kind: "command",
      name: "edit",
      text: "leo",
      channel: "C1",
      user: OWNER,
      triggerId: "T5",
    });
    expect(
      handleCommand(db, clock, {
        command: "/edit",
        text: "leo",
        channel_id: "C1",
        user_id: OWNER,
        trigger_id: "T5",
      }).inserted,
    ).toBe(false);
    db.close();
  });
});
