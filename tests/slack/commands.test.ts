import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadHome } from "../../src/config/loader.js";
import {
  type Daemon,
  dispatchButton,
  dispatchCommand,
  dispatchView,
} from "../../src/slack/commands.js";
import { FakeChat } from "../../src/slack/fake-chat.js";
import type { Inbound } from "../../src/slack/inbox.js";

const home = loadHome(fileURLToPath(new URL("../fixtures/home-valid/", import.meta.url)));
if (!home.ok) throw new Error("fixture");
const snapshot = home.snapshot;
const OWNER = snapshot.config.slack.owner_user_id;

function fakeDaemon(over: Partial<Daemon> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const rec =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push({ name, args });
      return { ok: true } as never;
    };
  const daemon: Daemon = {
    hire: rec("hire"),
    edit: rec("edit"),
    undoEdit: rec("undoEdit"),
    pause: rec("pause"),
    resume: rec("resume"),
    setModel: rec("setModel"),
    restart: rec("restart"),
    retire: rec("retire"),
    diag: async (agent) => `diag ${agent}`,
    openParked: rec("openParked"),
    answer: rec("answer"),
    approve: rec("approve"),
    deny: rec("deny"),
    reply: rec("reply"),
    currentText: async (agent, file) => `text of ${agent}/${file}`,
    homeView: async () => ({ type: "home", blocks: [] }),
    details: async () => ({ kind: "merge_production", payload: { branch: "master" } }),
    ...over,
  };
  return { daemon, calls };
}
const ctx = { snapshot, ownerUserId: OWNER };
type Command = Extract<Inbound, { kind: "command" }>;
type Button = Extract<Inbound, { kind: "button" }>;
type View = Extract<Inbound, { kind: "view_submitted" }>;
const command = (name: string, text = "", triggerId = "T1"): Command => ({
  kind: "command",
  name,
  text,
  channel: "C1",
  user: OWNER,
  triggerId,
});
const button = (actionId: string, value: string, extra: Partial<Button> = {}): Button => {
  const m = /^(\d+)(?::(\d+))?$/.exec(value);
  return {
    kind: "button",
    actionId,
    value,
    renderId: m ? Number(m[1]) : undefined,
    epoch: m?.[2] ? Number(m[2]) : undefined,
    selected: undefined,
    user: OWNER,
    channel: "C1",
    ts: "1700.2",
    triggerId: "T2",
    ...extra,
  };
};
const menu = (op: string, agent: string) =>
  button("agent_menu", `${op}:${agent}`, {
    selected: `${op}:${agent}`,
    renderId: undefined,
    epoch: undefined,
  });
const view = (
  callbackId: string,
  metadata: unknown,
  values: Record<string, string | null>,
): View => ({
  kind: "view_submitted",
  callbackId,
  viewId: "V1",
  metadata,
  values,
  user: OWNER,
  triggerId: "T3",
});
const ephemerals = (chat: FakeChat) =>
  chat.calls
    .filter((c) => c.method === "postEphemeral")
    .map((c) => (c.args as { text: string }).text);
const modals = (chat: FakeChat) =>
  chat.calls
    .filter((c) => c.method === "openModal")
    .map((c) => (c.args as { view: { callback_id: string; private_metadata?: string } }).view);

describe("dispatchCommand: exactly four commands", () => {
  it("/agentopolis publishes the Home, /hire opens the modal", async () => {
    const chat = new FakeChat();
    const f = fakeDaemon();
    await dispatchCommand(command("agentopolis"), f.daemon, chat, ctx);
    await dispatchCommand(command("hire"), f.daemon, chat, ctx);
    expect(chat.calls.map((c) => c.method)).toEqual(["publishHome", "openModal"]);
    expect(modals(chat)[0]?.callback_id).toBe("hire");
  });
  it("/edit <agent> [AGENT|MEMORY] opens the edit modal pre-filled; default AGENT.md", async () => {
    const chat = new FakeChat();
    const f = fakeDaemon();
    await dispatchCommand(command("edit", "ceo MEMORY"), f.daemon, chat, ctx);
    await dispatchCommand(command("edit", "ceo"), f.daemon, chat, ctx);
    await dispatchCommand(command("edit", "ceo SOUL"), f.daemon, chat, ctx);
    await dispatchCommand(command("edit", "ghost"), f.daemon, chat, ctx);
    const [memory, agentMd] = modals(chat) as {
      callback_id: string;
      private_metadata: string;
      blocks: { element: { initial_value: string } }[];
    }[];
    expect(memory?.callback_id).toBe("edit");
    expect(JSON.parse(memory?.private_metadata ?? "")).toEqual({ agent: "ceo", file: "MEMORY.md" });
    expect(memory?.blocks[0]?.element.initial_value).toBe("text of ceo/MEMORY.md");
    expect(JSON.parse(agentMd?.private_metadata ?? "")).toEqual({ agent: "ceo", file: "AGENT.md" });
    expect(modals(chat)).toHaveLength(2);
    expect(ephemerals(chat)[0]).toMatch(/Comandi:/);
    expect(ephemerals(chat)[1]).toMatch(/Non conosco l'agente "ghost"/);
  });
  it("/diag answers ephemerally; the removed commands and unknown ones get the usage line", async () => {
    const chat = new FakeChat();
    const f = fakeDaemon();
    await dispatchCommand(command("diag", "ceo"), f.daemon, chat, ctx);
    for (const removed of [
      "pause",
      "resume",
      "model",
      "budget",
      "costs",
      "pulse",
      "rollback",
      "dance",
    ]) {
      await dispatchCommand(command(removed, "ceo"), f.daemon, chat, ctx);
    }
    expect(f.calls).toEqual([]);
    expect(ephemerals(chat)[0]).toBe("diag ceo");
    expect(
      ephemerals(chat)
        .slice(1)
        .every((t) => t.startsWith("Comandi:")),
    ).toBe(true);
    expect(ephemerals(chat)).toHaveLength(9);
  });
});

describe("dispatchButton", () => {
  it("routes answer, approve, approve_task, deny with render id and epoch", async () => {
    const chat = new FakeChat();
    const f = fakeDaemon();
    await dispatchButton(button("answer", "7:1"), f.daemon, chat, ctx);
    await dispatchButton(button("answer_select", "7:2", { selected: "7:2" }), f.daemon, chat, ctx);
    await dispatchButton(button("approve", "9:3"), f.daemon, chat, ctx);
    await dispatchButton(button("approve_task", "9:3"), f.daemon, chat, ctx);
    await dispatchButton(button("deny", "9:3"), f.daemon, chat, ctx);
    await dispatchButton(button("snooze", "7"), f.daemon, chat, ctx); // no such action any more
    expect(f.calls).toEqual([
      { name: "answer", args: [7, 1, OWNER] },
      { name: "answer", args: [7, 2, OWNER] },
      { name: "approve", args: [9, 3, "once", OWNER] },
      { name: "approve", args: [9, 3, "task", OWNER] },
      { name: "deny", args: [9, 3, OWNER] },
    ]);
  });
  it("a stale epoch is refused with an ephemeral", async () => {
    const chat = new FakeChat();
    const f = fakeDaemon({ approve: async () => ({ ok: false, reason: "stale" }) });
    await dispatchButton(button("approve", "9:1"), f.daemon, chat, ctx);
    expect(ephemerals(chat)[0]).toMatch(/superata/);
  });
  it("details and reply open modals", async () => {
    const chat = new FakeChat();
    const f = fakeDaemon();
    await dispatchButton(button("details", "9:3"), f.daemon, chat, ctx);
    await dispatchButton(button("reply", "11"), f.daemon, chat, ctx);
    expect(modals(chat)).toHaveLength(2);
    expect(modals(chat)[1]?.callback_id).toBe("reply");
    expect(JSON.parse(modals(chat)[1]?.private_metadata ?? "")).toEqual({ renderId: 11 });
  });
  it("the agent overflow menu maps pause, resume, restart, retire to actions and model to a modal", async () => {
    const chat = new FakeChat();
    const f = fakeDaemon();
    for (const op of ["pause", "resume", "restart", "retire", "model"]) {
      await dispatchButton(menu(op, "ceo"), f.daemon, chat, ctx);
    }
    await dispatchButton(menu("pause", "ghost"), f.daemon, chat, ctx);
    await dispatchButton(menu("fire", "ceo"), f.daemon, chat, ctx);
    expect(f.calls).toEqual([
      { name: "pause", args: ["ceo"] },
      { name: "resume", args: ["ceo"] },
      { name: "restart", args: ["ceo"] },
      { name: "retire", args: ["ceo"] },
    ]);
    expect(modals(chat)[0]?.callback_id).toBe("model");
    expect(JSON.parse(modals(chat)[0]?.private_metadata ?? "")).toEqual({ agent: "ceo" });
    expect(ephemerals(chat).slice(0, 4)).toEqual([
      "⏸️ ceo è in pausa.",
      "🟢 ceo è di nuovo attivo.",
      "🟢 ceo ricomincia da capo (MEMORY.md conservata).",
      "🟢 ceo è stato licenziato.",
    ]);
    expect(ephemerals(chat)[4]).toMatch(/Non conosco l'agente "ghost"/);
    expect(ephemerals(chat)[5]).toMatch(/Comandi:/);
  });
  it("parked_open, undo_edit and home_hire", async () => {
    const chat = new FakeChat();
    const f = fakeDaemon();
    await dispatchButton(button("parked_open", "42"), f.daemon, chat, ctx);
    await dispatchButton(button("undo_edit", "ceo", { renderId: undefined }), f.daemon, chat, ctx);
    await dispatchButton(
      button("undo_edit", "ghost", { renderId: undefined }),
      f.daemon,
      chat,
      ctx,
    );
    await dispatchButton(button("home_hire", "hire", { renderId: undefined }), f.daemon, chat, ctx);
    expect(f.calls).toEqual([
      { name: "openParked", args: [42] },
      { name: "undoEdit", args: ["ceo"] },
    ]);
    expect(ephemerals(chat)[0]).toMatch(/Compito aperto/);
    expect(ephemerals(chat)[1]).toMatch(/ghost/);
    expect(modals(chat)[0]?.callback_id).toBe("hire");
  });
});

describe("dispatchView", () => {
  it("a valid hire form calls hire with parsed fields", async () => {
    const f = fakeDaemon();
    const r = await dispatchView(
      view("hire", {}, { role: "ceo", project: null, display: "Bea · CEO", model: null }),
      f.daemon,
      new FakeChat(),
      ctx,
    );
    expect(r).toBeUndefined();
    expect(f.calls[0]).toEqual({
      name: "hire",
      args: [{ role: "ceo", project: undefined, display: "Bea · CEO", model: undefined }],
    });
  });
  it("an unknown role or an empty display returns an errors response and calls nothing", async () => {
    const f = fakeDaemon();
    const r = await dispatchView(
      view("hire", {}, { role: "wizard", display: "" }),
      f.daemon,
      new FakeChat(),
      ctx,
    );
    expect(r).toEqual({
      response_action: "errors",
      errors: { role: "Ruolo sconosciuto: wizard", display: "Campo obbligatorio" },
    });
    expect(f.calls).toEqual([]);
  });
  it("edit, model and reply submissions reach their actions with the metadata", async () => {
    const f = fakeDaemon();
    const chat = new FakeChat();
    await dispatchView(
      view("edit", { agent: "ceo", file: "AGENT.md" }, { text: "nuovo testo" }),
      f.daemon,
      chat,
      ctx,
    );
    await dispatchView(view("model", { agent: "ceo" }, { model: "haiku" }), f.daemon, chat, ctx);
    await dispatchView(view("reply", { renderId: 5 }, { text: "rosso" }), f.daemon, chat, ctx);
    expect(f.calls).toEqual([
      { name: "edit", args: ["ceo", "AGENT.md", "nuovo testo"] },
      { name: "setModel", args: ["ceo", "haiku"] },
      { name: "reply", args: [5, "rosso", OWNER] },
    ]);
    expect(chat.calls.map((c) => c.method)).toEqual(["publishHome"]); // the Home is refreshed after a model change
    const bad = await dispatchView(
      view("edit", { agent: "ceo", file: "SOUL.md" }, { text: "x" }),
      f.daemon,
      chat,
      ctx,
    );
    expect(bad?.response_action).toBe("errors");
  });
});
