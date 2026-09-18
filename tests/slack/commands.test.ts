import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadHome } from "../../src/config/loader.js";
import {
  type DaemonActions,
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

function fakeActions(over: Partial<DaemonActions> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const rec =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push({ name, args });
      return { ok: true } as never;
    };
  const actions: DaemonActions = {
    hire: rec("hire"),
    edit: rec("edit"),
    currentText: async (agent, file) => `text of ${agent}/${file}`,
    pause: rec("pause"),
    resume: rec("resume"),
    setModel: rec("setModel"),
    setBudget: rec("setBudget"),
    costs: async () => "costi: 12.00 $ stimato",
    status: async () => "tutto ok",
    diag: async (agent) => `diag ${agent}`,
    rollback: rec("rollback"),
    homeView: async () => ({ type: "home", blocks: [] }),
    answer: rec("answer"),
    approve: rec("approve"),
    deny: rec("deny"),
    reply: rec("reply"),
    details: async () => ({ kind: "merge_production", payload: { branch: "master" } }),
    ...over,
  };
  return { actions, calls };
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
const ephemerals = (chat: FakeChat) =>
  chat.calls
    .filter((c) => c.method === "postEphemeral")
    .map((c) => (c.args as { text: string }).text);

describe("dispatchCommand", () => {
  it("/agentopolis publishes the home, /hire and /edit open modals", async () => {
    const chat = new FakeChat();
    const f = fakeActions();
    await dispatchCommand(command("agentopolis"), f.actions, chat, ctx);
    await dispatchCommand(command("hire"), f.actions, chat, ctx);
    await dispatchCommand(command("edit", "ceo JOB"), f.actions, chat, ctx);
    expect(chat.calls.map((c) => c.method)).toEqual(["publishHome", "openModal", "openModal"]);
    const edit = chat.calls[2]?.args as {
      view: {
        callback_id: string;
        private_metadata: string;
        blocks: { element: { initial_value: string } }[];
      };
    };
    expect(edit.view.callback_id).toBe("edit");
    expect(JSON.parse(edit.view.private_metadata)).toEqual({ agent: "ceo", file: "JOB.md" });
    expect(edit.view.blocks[0]?.element.initial_value).toBe("text of ceo/JOB.md");
  });
  it("maps agent commands 1:1 with parsed arguments and answers ephemerally", async () => {
    const chat = new FakeChat();
    const f = fakeActions();
    await dispatchCommand(command("pause", "ceo"), f.actions, chat, ctx);
    await dispatchCommand(command("resume", "ceo"), f.actions, chat, ctx);
    await dispatchCommand(command("model", "ceo opus"), f.actions, chat, ctx);
    await dispatchCommand(command("budget", "ceo 25"), f.actions, chat, ctx);
    await dispatchCommand(command("costs"), f.actions, chat, ctx);
    await dispatchCommand(command("pulse"), f.actions, chat, ctx);
    await dispatchCommand(command("diag", "ceo"), f.actions, chat, ctx);
    expect(f.calls).toEqual([
      { name: "pause", args: ["ceo"] },
      { name: "resume", args: ["ceo"] },
      { name: "setModel", args: ["ceo", "opus"] },
      { name: "setBudget", args: ["ceo", 25_000_000] },
    ]);
    expect(ephemerals(chat)).toHaveLength(7);
    expect(ephemerals(chat)[4]).toBe("costi: 12.00 $ stimato");
    expect(ephemerals(chat)[5]).toBe("tutto ok");
  });
  it("unknown agents, bad arguments and unknown commands get an Italian ephemeral, no action", async () => {
    const chat = new FakeChat();
    const f = fakeActions();
    await dispatchCommand(command("pause", "ghost"), f.actions, chat, ctx);
    await dispatchCommand(command("budget", "ceo molti"), f.actions, chat, ctx);
    await dispatchCommand(command("dance"), f.actions, chat, ctx);
    expect(f.calls).toEqual([]);
    expect(ephemerals(chat)[0]).toMatch(/Non conosco l'agente "ghost"/);
    expect(ephemerals(chat)[1]).toMatch(/numero/);
    expect(ephemerals(chat)[2]).toMatch(/Comandi:/);
  });
});

describe("dispatchButton", () => {
  it("routes answer, approve, approve_task, deny with render id and epoch; no snooze exists", async () => {
    const chat = new FakeChat();
    const f = fakeActions();
    await dispatchButton(button("answer", "7:1"), f.actions, chat, ctx);
    await dispatchButton(button("answer_select", "7:2", { selected: "7:2" }), f.actions, chat, ctx);
    await dispatchButton(button("snooze", "7"), f.actions, chat, ctx); // unknown action: ignored
    await dispatchButton(button("approve", "9:3"), f.actions, chat, ctx);
    await dispatchButton(button("approve_task", "9:3"), f.actions, chat, ctx);
    await dispatchButton(button("deny", "9:3"), f.actions, chat, ctx);
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
    const f = fakeActions({ approve: async () => ({ ok: false, reason: "stale" }) });
    await dispatchButton(button("approve", "9:1"), f.actions, chat, ctx);
    expect(ephemerals(chat)[0]).toMatch(/superata/);
  });
  it("details and reply open modals; the agent overflow menu maps to actions", async () => {
    const chat = new FakeChat();
    const f = fakeActions();
    await dispatchButton(button("details", "9:3"), f.actions, chat, ctx);
    await dispatchButton(button("reply", "11"), f.actions, chat, ctx);
    await dispatchButton(
      button("agent_menu", "pause:ceo", { selected: "pause:ceo", renderId: undefined }),
      f.actions,
      chat,
      ctx,
    );
    expect(chat.calls.filter((c) => c.method === "openModal")).toHaveLength(2);
    const reply = chat.calls[1]?.args as {
      view: { callback_id: string; private_metadata: string };
    };
    expect(reply.view.callback_id).toBe("reply");
    expect(JSON.parse(reply.view.private_metadata)).toEqual({ renderId: 11 });
    expect(f.calls.at(-1)).toEqual({ name: "pause", args: ["ceo"] });
  });
});

describe("dispatchView", () => {
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
  it("a valid hire form calls hire with parsed fields", async () => {
    const f = fakeActions();
    const r = await dispatchView(
      view(
        "hire",
        {},
        { role: "ceo", project: null, display: "Bea · CEO", model: null, budget: "30" },
      ),
      f.actions,
      new FakeChat(),
      ctx,
    );
    expect(r).toBeUndefined();
    expect(f.calls[0]).toEqual({
      name: "hire",
      args: [
        {
          role: "ceo",
          project: undefined,
          display: "Bea · CEO",
          model: undefined,
          budgetMicro: 30_000_000,
        },
      ],
    });
  });
  it("an unknown role or a bad budget returns an errors response and calls nothing", async () => {
    const f = fakeActions();
    const r = await dispatchView(
      view("hire", {}, { role: "wizard", display: "", budget: "tanti" }),
      f.actions,
      new FakeChat(),
      ctx,
    );
    expect(r).toEqual({
      response_action: "errors",
      errors: {
        role: "Ruolo sconosciuto: wizard",
        display: "Campo obbligatorio",
        budget: "Serve un numero positivo",
      },
    });
    expect(f.calls).toEqual([]);
  });
  it("edit and reply submissions reach their actions with the metadata", async () => {
    const f = fakeActions();
    await dispatchView(
      view("edit", { agent: "ceo", file: "SOUL.md" }, { text: "nuovo testo" }),
      f.actions,
      new FakeChat(),
      ctx,
    );
    await dispatchView(
      view("reply", { renderId: 5 }, { text: "rosso" }),
      f.actions,
      new FakeChat(),
      ctx,
    );
    expect(f.calls).toEqual([
      { name: "edit", args: ["ceo", "SOUL.md", "nuovo testo"] },
      { name: "reply", args: [5, "rosso", OWNER] },
    ]);
  });
});
