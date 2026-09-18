// Slash commands, buttons and modal submissions → daemon actions. Exactly four commands
// (spec section 9); everything else lives in the Home tab's menus. Every reply that is only
// for the owner is ephemeral. The actions themselves live behind a port (slice 4).
import type { Snapshot } from "../config/loader.js";
import type { Chat } from "../ports/chat.js";
import {
  AGENT_MENU_OPS,
  type AgentMenuOp,
  EDITABLE_FILES,
  type EditableFile,
  editModal,
  hireModal,
  modelModal,
  replyModal,
} from "./blocks.js";
import type { Inbound } from "./inbox.js";
import { S } from "./strings.js";

export type ActionResult = { ok: true } | { ok: false; reason: "stale" | "unknown" | string };
export type HireForm = {
  role: string;
  project: string | undefined;
  display: string;
  model: string | undefined;
};

/** What the owner can make the daemon do (revised plan, Task 8). Implemented in slice 4. */
export interface DaemonActions {
  hire(form: HireForm): Promise<ActionResult>;
  edit(agent: string, file: EditableFile, text: string): Promise<ActionResult>;
  undoEdit(agent: string): Promise<ActionResult>;
  pause(agent: string): Promise<ActionResult>;
  resume(agent: string): Promise<ActionResult>;
  setModel(agent: string, model: string): Promise<ActionResult>;
  restart(agent: string): Promise<ActionResult>;
  retire(agent: string): Promise<ActionResult>;
  diag(agent: string): Promise<string>;
  openParked(taskId: number): Promise<ActionResult>;
  answer(renderId: number, index: number, user: string): Promise<ActionResult>;
  approve(
    renderId: number,
    epoch: number,
    scope: "once" | "task",
    user: string,
  ): Promise<ActionResult>;
  deny(renderId: number, epoch: number, user: string): Promise<ActionResult>;
  reply(renderId: number, text: string, user: string): Promise<ActionResult>;
}

/** Reads the dispatcher needs to render (not actions): the modal pre-fill, the Home, Dettagli. */
export interface DaemonReads {
  currentText(agent: string, file: EditableFile): Promise<string>;
  homeView(user: string): Promise<unknown>;
  details(renderId: number): Promise<unknown>;
}

export type Daemon = DaemonActions & DaemonReads;
export type DispatchContext = { snapshot: Snapshot; ownerUserId: string };
type Command = Extract<Inbound, { kind: "command" }>;
type Button = Extract<Inbound, { kind: "button" }>;
type View = Extract<Inbound, { kind: "view_submitted" }>;

const MODELS = ["opus", "sonnet", "haiku"];
const say = (chat: Chat, channel: string, user: string, text: string) =>
  chat.postEphemeral({ channel, user, text });
const hireForm = (ctx: DispatchContext) =>
  hireModal({
    roles: [...ctx.snapshot.roles.keys()],
    projects: [...ctx.snapshot.projects.keys()],
    models: MODELS,
  });

export async function dispatchCommand(
  c: Command,
  daemon: Daemon,
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
  switch (c.name) {
    case "agentopolis":
      return chat.publishHome(c.user, await daemon.homeView(c.user));
    case "hire":
      return chat.openModal(c.triggerId, hireForm(ctx));
    case "edit": {
      const agent = await agentOr(arg1);
      if (!agent) return;
      const file = `${(arg2 ?? "AGENT").toUpperCase().replace(/\.MD$/, "")}.md` as EditableFile;
      if (!EDITABLE_FILES.includes(file)) return reply(S.usage);
      const initial = await daemon.currentText(agent, file);
      return chat.openModal(c.triggerId, editModal({ agent, file, initial }));
    }
    case "diag": {
      const agent = await agentOr(arg1);
      if (agent) await reply(await daemon.diag(agent));
      return;
    }
    default:
      return reply(S.usage);
  }
}

export async function dispatchButton(
  b: Button,
  daemon: Daemon,
  chat: Chat,
  ctx: DispatchContext,
): Promise<void> {
  const channel = b.channel ?? "";
  const reply = (text: string) => (channel ? say(chat, channel, b.user, text) : Promise.resolve());
  const report = async (r: ActionResult, okText?: string) => {
    if (!r.ok) return reply(r.reason === "stale" ? S.staleCard : `${S.failed}: ${r.reason}`);
    if (okText) return reply(okText);
  };
  const need = (v: number | undefined, what: string): v is number => {
    if (v === undefined) {
      void reply(`${S.failed}: ${what}`);
      return false;
    }
    return true;
  };
  // action_ids are unique per payload ("answer:0", "agent_menu:leo"); the prefix routes
  const base = b.actionId.split(":")[0] ?? b.actionId;
  switch (base) {
    case "answer":
    case "answer_select": {
      const m = /^(\d+):(\d+)$/.exec(b.selected ?? b.value);
      if (!m) return reply(S.failed);
      return report(await daemon.answer(Number(m[1]), Number(m[2]), b.user));
    }
    case "answer_confirm":
      return; // the selection itself is dispatched on answer_select
    case "approve":
    case "approve_task":
      if (!need(b.renderId, "render") || !need(b.epoch, "epoch")) return;
      return report(
        await daemon.approve(
          b.renderId,
          b.epoch,
          b.actionId === "approve_task" ? "task" : "once",
          b.user,
        ),
      );
    case "deny":
      if (!need(b.renderId, "render") || !need(b.epoch, "epoch")) return;
      return report(await daemon.deny(b.renderId, b.epoch, b.user));
    case "details": {
      if (!need(b.renderId, "render")) return;
      const payload = await daemon.details(b.renderId);
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
    case "undo_edit": {
      const agent = b.value;
      if (!ctx.snapshot.agents.has(agent)) return reply(S.unknownAgent(agent));
      return report(await daemon.undoEdit(agent));
    }
    case "parked_open": {
      const taskId = Number(b.value);
      if (!Number.isInteger(taskId)) return reply(S.failed);
      return report(await daemon.openParked(taskId), S.done.parkedOpened);
    }
    case "home_hire":
      return chat.openModal(b.triggerId, hireForm(ctx));
    case "agent_menu": {
      const [op, agent] = (b.selected ?? b.value).split(":") as [
        AgentMenuOp | undefined,
        string | undefined,
      ];
      if (!agent || !ctx.snapshot.agents.has(agent)) return reply(S.unknownAgent(agent ?? ""));
      if (!op || !AGENT_MENU_OPS.includes(op)) return reply(S.usage);
      switch (op) {
        case "pause":
          return report(await daemon.pause(agent), S.done.paused(agent));
        case "resume":
          return report(await daemon.resume(agent), S.done.resumed(agent));
        case "model": {
          const current = ctx.snapshot.agents.get(agent)?.model ?? undefined;
          return chat.openModal(b.triggerId, modelModal({ agent, models: MODELS, current }));
        }
        case "restart":
          return report(await daemon.restart(agent), S.done.restarted(agent));
        case "retire":
          return report(await daemon.retire(agent), S.done.retired(agent));
      }
      return;
    }
    default:
      return; // home_open / home_go navigate in Slack itself; nothing to do server-side
  }
}

export type ViewResponse =
  | { response_action: "errors"; errors: Record<string, string> }
  | undefined;

export async function dispatchView(
  v: View,
  daemon: Daemon,
  chat: Chat,
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
      await daemon.hire({
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
      const file = String(meta.file ?? "") as EditableFile;
      if (!EDITABLE_FILES.includes(file))
        return { response_action: "errors", errors: { text: S.usage } };
      await daemon.edit(String(meta.agent ?? ""), file, text);
      return undefined;
    }
    case "model": {
      const model = v.values.model ?? "";
      if (!model) return { response_action: "errors", errors: { model: S.required } };
      const agent = String(meta.agent ?? "");
      const r = await daemon.setModel(agent, model);
      if (r.ok) await chat.publishHome(v.user, await daemon.homeView(v.user));
      return undefined;
    }
    case "reply": {
      const text = (v.values.text ?? "").trim();
      if (!text) return { response_action: "errors", errors: { text: S.required } };
      await daemon.reply(Number(meta.renderId), text, v.user);
      return undefined;
    }
    default:
      return undefined;
  }
}
