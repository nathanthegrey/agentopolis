// Slash commands, buttons and modal submissions → daemon actions. Every reply that is only
// for the owner is ephemeral. The actions themselves live behind a port (slice 4).
import type { Snapshot } from "../config/loader.js";
import type { Chat } from "../ports/chat.js";
import { EDITABLE_FILES, type EditableFile, editModal, hireModal, replyModal } from "./blocks.js";
import type { Inbound } from "./inbox.js";
import { S } from "./strings.js";

export type ActionResult = { ok: true } | { ok: false; reason: "stale" | "unknown" | string };
export type HireForm = {
  role: string;
  project: string | undefined;
  display: string;
  model: string | undefined;
};

export interface DaemonActions {
  hire(form: HireForm): Promise<ActionResult>;
  edit(agent: string, file: string, text: string): Promise<ActionResult>;
  currentText(agent: string, file: string): Promise<string>;
  pause(agent: string): Promise<ActionResult>;
  resume(agent: string): Promise<ActionResult>;
  setModel(agent: string, model: string): Promise<ActionResult>;
  costs(): Promise<string>;
  status(): Promise<string>;
  diag(agent: string): Promise<string>;
  rollback(index: number): Promise<ActionResult>;
  homeView(user: string): Promise<unknown>;
  answer(renderId: number, index: number, user: string): Promise<ActionResult>;
  approve(
    renderId: number,
    epoch: number,
    scope: "once" | "task",
    user: string,
  ): Promise<ActionResult>;
  deny(renderId: number, epoch: number, user: string): Promise<ActionResult>;
  reply(renderId: number, text: string, user: string): Promise<ActionResult>;
  details(renderId: number): Promise<unknown>;
}

export type DispatchContext = { snapshot: Snapshot; ownerUserId: string };
type Command = Extract<Inbound, { kind: "command" }>;
type Button = Extract<Inbound, { kind: "button" }>;
type View = Extract<Inbound, { kind: "view_submitted" }>;

const say = (chat: Chat, channel: string, user: string, text: string) =>
  chat.postEphemeral({ channel, user, text });

export async function dispatchCommand(
  c: Command,
  actions: DaemonActions,
  chat: Chat,
  ctx: DispatchContext,
): Promise<void> {
  const [arg1, arg2] = c.text.split(/\s+/).filter(Boolean);
  const reply = (text: string) => say(chat, c.channel, c.user, text);
  const agentOr = async (name: string | undefined): Promise<string | undefined> => {
    if (name && ctx.snapshot.agents.has(name)) return name;
    await reply(name ? S.unknownAgent(name) : S.usage);
    return undefined;
  };
  const report = async (r: ActionResult, okText: string) =>
    reply(r.ok ? okText : `${S.failed}: ${r.reason}`);

  switch (c.name) {
    case "agentopolis":
      return chat.publishHome(c.user, await actions.homeView(c.user));
    case "hire":
      return chat.openModal(
        c.triggerId,
        hireModal({
          roles: [...ctx.snapshot.roles.keys()],
          projects: [...ctx.snapshot.projects.keys()],
          models: ["opus", "sonnet", "haiku"],
        }),
      );
    case "edit": {
      const agent = await agentOr(arg1);
      if (!agent) return;
      const file = `${(arg2 ?? "AGENT").toUpperCase().replace(/\.MD$/, "")}.md` as EditableFile;
      if (!EDITABLE_FILES.includes(file)) return reply(S.usage);
      const initial = await actions.currentText(agent, file);
      return chat.openModal(c.triggerId, editModal({ agent, file, initial }));
    }
    case "pause": {
      const agent = await agentOr(arg1);
      if (agent) await report(await actions.pause(agent), S.paused(agent));
      return;
    }
    case "resume": {
      const agent = await agentOr(arg1);
      if (agent) await report(await actions.resume(agent), S.resumed(agent));
      return;
    }
    case "model": {
      const agent = await agentOr(arg1);
      if (!agent) return;
      if (!arg2) return reply(S.usage);
      return report(await actions.setModel(agent, arg2), S.modelSet(agent, arg2));
    }
    case "costs":
      return reply(await actions.costs());
    case "pulse":
      return reply(await actions.status());
    case "diag": {
      const agent = await agentOr(arg1);
      if (agent) await reply(await actions.diag(agent));
      return;
    }
    case "rollback": {
      const index = Number(arg1 ?? "0");
      return report(await actions.rollback(Number.isInteger(index) ? index : 0), S.rolledBack);
    }
    default:
      return reply(S.usage);
  }
}

export async function dispatchButton(
  b: Button,
  actions: DaemonActions,
  chat: Chat,
  ctx: DispatchContext,
): Promise<void> {
  const channel = b.channel ?? "";
  const reply = (text: string) => (channel ? say(chat, channel, b.user, text) : Promise.resolve());
  const report = async (r: ActionResult) => {
    if (!r.ok) await reply(r.reason === "stale" ? S.staleCard : `${S.failed}: ${r.reason}`);
  };
  const need = (v: number | undefined, what: string): v is number => {
    if (v === undefined) {
      void reply(`${S.failed}: ${what}`);
      return false;
    }
    return true;
  };
  switch (b.actionId) {
    case "answer":
    case "answer_select": {
      const m = /^(\d+):(\d+)$/.exec(b.selected ?? b.value);
      if (!m) return reply(S.failed);
      return report(await actions.answer(Number(m[1]), Number(m[2]), b.user));
    }
    case "answer_confirm":
      return; // the selection itself is dispatched on answer_select
    case "approve":
    case "approve_task":
      if (!need(b.renderId, "render") || !need(b.epoch, "epoch")) return;
      return report(
        await actions.approve(
          b.renderId,
          b.epoch,
          b.actionId === "approve_task" ? "task" : "once",
          b.user,
        ),
      );
    case "deny":
      if (!need(b.renderId, "render") || !need(b.epoch, "epoch")) return;
      return report(await actions.deny(b.renderId, b.epoch, b.user));
    case "details": {
      if (!need(b.renderId, "render")) return;
      const payload = await actions.details(b.renderId);
      const body = `\`\`\`\n${JSON.stringify(payload, null, 2).slice(0, 2_900)}\n\`\`\``;
      return chat.openModal(b.triggerId, {
        type: "modal",
        title: { type: "plain_text", text: S.details },
        close: { type: "plain_text", text: S.cancel },
        blocks: [{ type: "section", text: { type: "mrkdwn", text: body } }],
      });
    }
    case "reply":
      if (!need(b.renderId, "render")) return;
      return chat.openModal(
        b.triggerId,
        replyModal({ renderId: b.renderId, question: S.replyLabel }),
      );
    case "home_open":
    case "home_go":
    case "home_costs":
      return reply(await actions.costs());
    case "home_hire":
      return chat.openModal(
        b.triggerId,
        hireModal({
          roles: [...ctx.snapshot.roles.keys()],
          projects: [...ctx.snapshot.projects.keys()],
          models: ["opus", "sonnet", "haiku"],
        }),
      );
    case "agent_menu": {
      const [op, agent] = (b.selected ?? b.value).split(":");
      if (!agent || !ctx.snapshot.agents.has(agent)) return reply(S.unknownAgent(agent ?? ""));
      if (op === "pause") return report(await actions.pause(agent));
      if (op === "fire") return reply(S.useHireToFire);
      return reply(S.usage);
    }
    default:
      return;
  }
}

export type ViewResponse =
  | { response_action: "errors"; errors: Record<string, string> }
  | undefined;

export async function dispatchView(
  v: View,
  actions: DaemonActions,
  _chat: Chat,
  ctx: DispatchContext,
): Promise<ViewResponse> {
  const meta = (v.metadata ?? {}) as Record<string, unknown>;
  switch (v.callbackId) {
    case "hire": {
      const errors: Record<string, string> = {};
      const role = v.values.role ?? "";
      if (!ctx.snapshot.roles.has(role)) errors.role = S.unknownRole(role);
      const display = (v.values.display ?? "").trim();
      if (!display) errors.display = S.required;
      if (Object.keys(errors).length) return { response_action: "errors", errors };
      await actions.hire({
        role,
        project: v.values.project ?? undefined,
        display,
        model: v.values.model ?? undefined,
      });
      return undefined;
    }
    case "edit": {
      const text = v.values.text ?? "";
      if (!text.trim()) return { response_action: "errors", errors: { text: S.required } };
      await actions.edit(String(meta.agent ?? ""), String(meta.file ?? ""), text);
      return undefined;
    }
    case "reply": {
      const text = (v.values.text ?? "").trim();
      if (!text) return { response_action: "errors", errors: { text: S.required } };
      await actions.reply(Number(meta.renderId), text, v.user);
      return undefined;
    }
    default:
      return undefined;
  }
}
