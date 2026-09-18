// Block Kit builders. Pure: same input, same blocks. Every builder passes through limits.ts.
import type { Blocks } from "../ports/chat.js";
import { assertBlocks, LIMITS, splitText, truncateButton } from "./limits.js";
import { hhmm, S } from "./strings.js";

export type Card = { text: string; blocks: Blocks };

const mrkdwn = (text: string) => ({ type: "mrkdwn", text });
const plain = (text: string) => ({ type: "plain_text", text, emoji: true });
const section = (text: string) => ({ type: "section", text: mrkdwn(text) });
const context = (...texts: string[]) => ({ type: "context", elements: texts.map(mrkdwn) });
const divider = () => ({ type: "divider" });
const button = (
  text: string,
  actionId: string,
  value: string,
  extra: { style?: "primary" | "danger"; confirm?: unknown } = {},
) => ({
  type: "button",
  text: plain(truncateButton(text)),
  action_id: actionId,
  value: value.slice(0, LIMITS.buttonValue),
  ...(extra.style ? { style: extra.style } : {}),
  ...(extra.confirm ? { confirm: extra.confirm } : {}),
});
const actions = (elements: unknown[], blockId?: string) => ({
  type: "actions",
  ...(blockId ? { block_id: blockId } : {}),
  elements,
});
const finish = (text: string, blocks: unknown[]): Card => {
  assertBlocks(blocks, LIMITS.blocksPerMessage);
  return { text, blocks };
};
/** the first 3,000 chars of a long text as one section, the rest as further sections */
const sections = (text: string) => splitText(text).map(section);

// ---- asks ----------------------------------------------------------------------------------

export type AskCardInput = {
  renderId: number;
  persona: string;
  project: string | undefined;
  question: string;
  options: string[];
};

export function askCard(a: AskCardInput): Card {
  const ctx = [S.asks(a.persona), ...(a.project ? [a.project] : [])].join(" · ");
  // no snooze button and no re-mention: an open ask simply stays open (spec section 9)
  const row =
    a.options.length <= 3
      ? a.options.map((o, i) => button(o, `answer:${i}`, `${a.renderId}:${i}`))
      : [
          {
            type: "static_select",
            action_id: "answer_select",
            placeholder: plain(S.choose),
            options: a.options.map((o, i) => ({
              text: plain(truncateButton(o)),
              value: `${a.renderId}:${i}`,
            })),
          },
          button(S.confirm, "answer_confirm", String(a.renderId)),
        ];
  return finish(a.question, [
    ...sections(a.question),
    context(ctx),
    actions(row, `ask:${a.renderId}`),
  ]);
}

export function answeredCard(card: Card, r: { chosen: string; by: string; at: number }): Card {
  const kept = card.blocks.filter((b) => (b as { type: string }).type !== "actions");
  return finish(card.text, [...kept, context(S.chosen(r.chosen, r.by, hhmm(r.at)))]);
}

// ---- approvals -----------------------------------------------------------------------------

export type ApprovalCardInput = {
  renderId: number;
  epoch: number;
  kind: string;
  line: string;
  context: string;
  destructive: boolean;
  scoped: boolean;
};

export function approvalCard(a: ApprovalCardInput): Card {
  const value = `${a.renderId}:${a.epoch}`;
  const confirm = a.destructive
    ? {
        title: plain(S.denyConfirmTitle),
        text: mrkdwn(S.denyConfirmText),
        confirm: plain(S.yes),
        deny: plain(S.no),
        style: "danger",
      }
    : undefined;
  const row = [
    button(S.approve, "approve", value, { style: "primary" }),
    ...(a.scoped ? [button(S.approveTask, "approve_task", value)] : []),
    button(S.deny, "deny", value, { style: "danger", ...(confirm ? { confirm } : {}) }),
    button(S.details, "details", value),
  ];
  return finish(a.line, [
    ...sections(a.line),
    context(a.context),
    actions(row, `approval:${a.renderId}`),
  ]);
}

export function decidedCard(
  card: Card,
  d: {
    outcome: "approvato" | "negato" | "scaduta";
    by: string | undefined;
    at: number;
    reopen: boolean;
  },
): Card {
  const kept = card.blocks.filter((b) => (b as { type: string }).type !== "actions");
  const line =
    d.outcome === "scaduta" ? S.decided.scaduta() : S.decided[d.outcome](d.by ?? "?", hhmm(d.at));
  const renderId =
    (
      (
        card.blocks.find((b) => (b as { type: string }).type === "actions") as
          | { block_id?: string }
          | undefined
      )?.block_id ?? ""
    ).split(":")[1] ?? "";
  const tail = d.reopen ? [actions([button(S.reopen, "reopen", renderId)])] : [];
  return finish(card.text, [...kept, context(line), ...tail]);
}

// ---- tasks, status, receipts ---------------------------------------------------------------

export function taskCard(t: {
  title: string;
  state: string;
  costMicro: number | null;
  agents: string[];
}): Card {
  return finish(`${t.title} · ${t.state}`, [
    section(`*${t.title}*`),
    context(S.task.state(t.state), S.task.cost(t.costMicro), S.task.agents(t.agents)),
  ]);
}
export const taskCardUpdate = taskCard;

export function statusLine(s: { display: string; seconds: number }): string {
  return S.working(s.display, S.duration(s.seconds));
}

export function receipt(r: { display: string; seconds: number; costMicro: number | null }): string {
  return S.finished(
    r.display,
    S.duration(r.seconds),
    r.costMicro === null ? S.costUnknown : S.costEstimated(r.costMicro),
  );
}

// ---- free-text asks ------------------------------------------------------------------------

export function replyPrompt(p: { text: string; mention: string | undefined }): Card {
  const text = p.mention ? `<@${p.mention}> ${p.text}` : p.text;
  return finish(text, sections(text));
}

export function replyButton(renderId: number): Card {
  return finish(S.reply, [
    actions([button(S.reply, "reply", String(renderId))], `reply:${renderId}`),
  ]);
}

// ---- home ----------------------------------------------------------------------------------

export type HomeInput = {
  month: string;
  spentMicro: number;
  waiting: { text: string; renderId: number }[];
  projects: { slug: string; name: string; channel: string }[];
  agents: { name: string; display: string; state: string; spentMicro: number }[];
  parked: { taskId: number; text: string }[];
  updatedAt: number;
};

/** the per-agent overflow menu: action_id "agent_menu:<agent>", value "<op>:<agent>" */
export const AGENT_MENU_OPS = ["pause", "resume", "model", "restart", "retire"] as const;
export type AgentMenuOp = (typeof AGENT_MENU_OPS)[number];

export function homeView(h: HomeInput): unknown {
  const blocks: unknown[] = [
    { type: "header", text: plain(S.home.title) },
    context(S.home.spend(h.month, h.spentMicro)),
    section(`*${S.home.waiting}*`),
  ];
  if (h.waiting.length === 0) blocks.push(context(S.home.nothingWaiting));
  for (const w of h.waiting.slice(0, 5)) {
    blocks.push({
      type: "section",
      text: mrkdwn(w.text),
      accessory: button(S.home.open, `home_open:${w.renderId}`, String(w.renderId)),
    });
  }
  blocks.push(divider(), section(`*${S.home.projects}*`));
  for (const p of h.projects) {
    blocks.push({
      type: "section",
      text: mrkdwn(p.name),
      accessory: button(S.home.go, `home_go:${p.slug}`, p.slug),
    });
  }
  const parked: unknown[] = [];
  if (h.parked.length) {
    parked.push(divider(), section(`*${S.home.parked}*`));
    for (const p of h.parked.slice(0, 10)) {
      parked.push({
        type: "section",
        text: mrkdwn(p.text),
        accessory: button(S.home.openAsTask, `parked_open:${p.taskId}`, String(p.taskId)),
      });
    }
  }
  blocks.push(divider(), section(`*${S.home.agents}*`));
  const overflow = (name: string) => ({
    type: "overflow",
    action_id: `agent_menu:${name}`,
    options: AGENT_MENU_OPS.map((op) => ({
      text: plain(S.home.overflow[op]),
      value: `${op}:${name}`,
    })),
  });
  const tail: unknown[] = [
    ...parked,
    actions([button(S.home.hire, "home_hire", "hire")]),
    context(S.home.updated(hhmm(h.updatedAt))),
  ];
  // one section per agent (its overflow menu is an accessory), cut so that the whole view fits
  const room = LIMITS.blocksPerView - blocks.length - tail.length - 1; // 1 for the "…e altri" line
  const shown = h.agents.slice(0, Math.max(0, room));
  for (const a of shown) {
    blocks.push({
      type: "section",
      text: mrkdwn(S.home.agentLine(a.display, a.state, a.spentMicro)),
      accessory: overflow(a.name),
    });
  }
  if (shown.length < h.agents.length)
    blocks.push(context(S.home.more(h.agents.length - shown.length)));
  blocks.push(...tail);
  assertBlocks(blocks, LIMITS.blocksPerView);
  return { type: "home", blocks };
}

// ---- edits ---------------------------------------------------------------------------------

/** posted by the daemon after /edit: "AGENT.md di Leo aggiornato · +3 −1 righe" */
export function editedCard(e: {
  renderId: number;
  agent: string;
  file: EditableFile;
  added: number;
  removed: number;
}): Card {
  const text = S.edit.updated(e.file, e.agent, e.added, e.removed);
  return finish(text, [
    section(text),
    actions(
      [
        button(S.edit.diff, "details", `${e.renderId}:0`),
        button(S.edit.undo, "undo_edit", e.agent),
      ],
      `edit:${e.renderId}`,
    ),
  ]);
}

export function undoneCard(card: Card, e: { agent: string; file: EditableFile }): Card {
  const kept = card.blocks.filter((b) => (b as { type: string }).type !== "actions");
  return finish(card.text, [...kept, context(S.edit.undone(e.file, e.agent))]);
}

// ---- modals --------------------------------------------------------------------------------

const modal = (
  callbackId: string,
  title: string,
  submit: string,
  blocks: unknown[],
  metadata: unknown,
) => {
  const privateMetadata = JSON.stringify(metadata);
  if (privateMetadata.length > LIMITS.privateMetadata) {
    throw new Error(
      `private_metadata of ${privateMetadata.length} chars exceeds ${LIMITS.privateMetadata}`,
    );
  }
  assertBlocks(blocks, LIMITS.blocksPerView);
  return {
    type: "modal",
    callback_id: callbackId,
    title: plain(title.slice(0, LIMITS.modalTitle)),
    submit: plain(submit),
    close: plain(S.cancel),
    private_metadata: privateMetadata,
    blocks,
  };
};
const input = (blockId: string, label: string, element: unknown, optional = false) => ({
  type: "input",
  block_id: blockId,
  label: plain(label),
  element,
  optional,
});
const select = (actionId: string, options: string[], initial?: string) => ({
  type: "static_select",
  action_id: actionId,
  options: options.map((o) => ({ text: plain(o), value: o })),
  ...(initial && options.includes(initial)
    ? { initial_option: { text: plain(initial), value: initial } }
    : {}),
});
const textInput = (actionId: string, extra: { multiline?: boolean; initial?: string } = {}) => ({
  type: "plain_text_input",
  action_id: actionId,
  ...(extra.multiline ? { multiline: true } : {}),
  ...(extra.initial !== undefined ? { initial_value: extra.initial } : {}),
});

export function hireModal(d: { roles: string[]; projects: string[]; models: string[] }): unknown {
  return modal(
    "hire",
    S.hire.title,
    S.hire.submit,
    [
      input("role", S.hire.role, select("role", d.roles)),
      input("project", S.hire.project, select("project", d.projects), true),
      input("display", S.hire.display, textInput("display")),
      input("model", S.hire.model, select("model", d.models), true),
    ],
    {},
  );
}

/** the two files the owner edits from Slack (spec section 9); prose files are edited in git */
export type EditableFile = "AGENT.md" | "MEMORY.md";
export const EDITABLE_FILES: readonly EditableFile[] = ["AGENT.md", "MEMORY.md"];

export function editModal(d: { agent: string; file: EditableFile; initial: string }): unknown {
  return modal(
    "edit",
    S.edit.title(d.file),
    S.edit.submit,
    [input("text", S.edit.label, textInput("text", { multiline: true, initial: d.initial }))],
    { agent: d.agent, file: d.file },
  );
}

export function replyModal(d: { renderId: number; question: string }): unknown {
  return modal(
    "reply",
    S.replyTitle,
    S.send,
    [...sections(d.question), input("text", S.replyLabel, textInput("text", { multiline: true }))],
    { renderId: d.renderId },
  );
}

export function modelModal(d: {
  agent: string;
  models: string[];
  current: string | undefined;
}): unknown {
  return modal(
    "model",
    S.model.title,
    S.model.submit,
    [input("model", S.model.label, select("model", d.models, d.current))],
    { agent: d.agent },
  );
}
