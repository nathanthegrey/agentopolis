import { describe, expect, it } from "vitest";
import {
  answeredCard,
  approvalCard,
  askCard,
  decidedCard,
  editedCard,
  editModal,
  hireModal,
  homeView,
  modelModal,
  receipt,
  replyButton,
  replyModal,
  replyPrompt,
  statusLine,
  taskCard,
  undoneCard,
} from "../../src/slack/blocks.js";
import { LIMITS } from "../../src/slack/limits.js";

type Block = {
  type: string;
  elements?: Element[];
  text?: { text: string };
  fields?: unknown[];
  block_id?: string;
};
type Element = {
  type: string;
  action_id?: string;
  value?: string;
  style?: string;
  confirm?: unknown;
  text?: { text: string };
  options?: unknown[];
};
const blocksOf = (card: { blocks: unknown[] }) => card.blocks as Block[];
const actions = (card: { blocks: unknown[] }) =>
  blocksOf(card).find((b) => b.type === "actions")?.elements ?? [];
const AT = Date.UTC(2026, 8, 18, 16, 30); // 18:30 in Europe/Rome (CEST)

describe("askCard", () => {
  const base = {
    renderId: 7,
    persona: "Ada",
    project: "agentopolis",
    question: "Procedo?",
  };
  it("renders up to three options as buttons plus Più tardi, with render id and index in the value", () => {
    const c = askCard({ ...base, options: ["Sì", "No", "Dopo"] });
    expect(c.text).toBe("Procedo?");
    const a = actions(c);
    expect(a.map((e) => e.action_id)).toEqual(["answer", "answer", "answer"]);
    expect(a.map((e) => e.value)).toEqual(["7:0", "7:1", "7:2"]);
    expect(JSON.stringify(c.blocks)).not.toContain("Più tardi");
    expect(a[0]?.text?.text).toBe("Sì");
    const ctx = blocksOf(c).find((b) => b.type === "context");
    expect(JSON.stringify(ctx)).toContain("Ada chiede");
    expect(JSON.stringify(ctx)).toContain("agentopolis");
    expect(JSON.stringify(ctx)).not.toMatch(/budget/i);
  });
  it("uses a static_select and Conferma beyond three options", () => {
    const c = askCard({ ...base, options: ["a", "b", "c", "d"] });
    const a = actions(c);
    expect(a[0]?.type).toBe("static_select");
    expect(a[0]?.options).toHaveLength(4);
    expect(a.map((e) => e.action_id)).toEqual(["answer_select", "answer_confirm"]);
  });
  it("truncates long button labels and never exceeds the block cap", () => {
    const c = askCard({ ...base, options: ["x".repeat(200)] });
    expect(actions(c)[0]?.text?.text).toHaveLength(LIMITS.buttonText);
    expect(c.blocks.length).toBeLessThanOrEqual(LIMITS.blocksPerMessage);
  });
  it("answeredCard keeps the question and replaces the actions with a context line", () => {
    const c = askCard({ ...base, options: ["Sì", "No"] });
    const a = answeredCard(c, { chosen: "Sì", by: "Nathan", at: AT });
    expect(a.text).toBe("Procedo?");
    expect(blocksOf(a).some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(a.blocks)).toContain("✅ Scelto: Sì · da Nathan alle 18:30");
  });
});

describe("approvalCard", () => {
  const base = {
    renderId: 9,
    epoch: 2,
    kind: "merge_production",
    line: "Leo chiede di unire dev in master",
    context: "budget 3.00 $",
  };
  it("has Approva primary, Nega danger, Dettagli; value carries render id and epoch", () => {
    const c = approvalCard({ ...base, destructive: false, scoped: false });
    const a = actions(c);
    expect(a.map((e) => e.action_id)).toEqual(["approve", "deny", "details"]);
    expect(a[0]?.style).toBe("primary");
    expect(a[1]?.style).toBe("danger");
    expect(a[1]?.confirm).toBeUndefined();
    expect(a.map((e) => e.value)).toEqual(["9:2", "9:2", "9:2"]);
  });
  it("adds Approva per questo compito when scoped and a confirm dialog when destructive", () => {
    const c = approvalCard({ ...base, destructive: true, scoped: true });
    const a = actions(c);
    expect(a.map((e) => e.action_id)).toEqual(["approve", "approve_task", "deny", "details"]);
    expect(a[2]?.confirm).toBeDefined();
  });
  it("decidedCard rewrites the outcome and offers Riapri only on expiry", () => {
    const c = approvalCard({ ...base, destructive: false, scoped: false });
    const d = decidedCard(c, { outcome: "approvato", by: "Nathan", at: AT, reopen: false });
    expect(JSON.stringify(d.blocks)).toContain("✅ Approvato");
    expect(blocksOf(d).some((b) => b.type === "actions")).toBe(false);
    const e = decidedCard(c, { outcome: "scaduta", by: undefined, at: AT, reopen: true });
    expect(JSON.stringify(e.blocks)).toContain("Scaduta: nessuno ha risposto");
    expect(actions(e).map((x) => x.action_id)).toEqual(["reopen"]);
  });
});

describe("task card, status line, receipt, reply", () => {
  it("taskCard shows title, state, cost so far (stimato) and agents; no budget", () => {
    const c = taskCard({
      title: "Fix login",
      state: "in corso",
      costMicro: 1_500_000,
      agents: ["Nina · developer"],
    });
    const s = JSON.stringify(c.blocks);
    expect(c.text).toContain("Fix login");
    expect(s).toContain("🟡 in corso");
    expect(s).toContain("costo 1.50 $ stimato");
    expect(s).not.toMatch(/budget/i);
    expect(s).toContain("Nina · developer");
  });
  it("statusLine and receipt are single lines with duration and estimated cost", () => {
    expect(statusLine({ display: "Leo", seconds: 125 })).toBe("Leo sta lavorando · 2 min");
    expect(receipt({ display: "Leo", seconds: 65, costMicro: 12_300 })).toBe(
      "Leo ha finito · 1 min · 0.01 $ stimato",
    );
    expect(receipt({ display: "Leo", seconds: 5, costMicro: null })).toBe(
      "Leo ha finito · 5 s · costo sconosciuto",
    );
  });
  it("replyPrompt is persona text with the mention, replyButton is a separate app line", () => {
    const p = replyPrompt({ text: "Che ne pensi?", mention: "U1" });
    expect(p.text).toBe("<@U1> Che ne pensi?");
    const b = replyButton(11);
    expect(actions(b).map((e) => e.action_id)).toEqual(["reply"]);
    expect(actions(b)[0]?.value).toBe("11");
  });
});

describe("homeView", () => {
  const agent = (i: number) => ({
    display: `Agent ${i}`,
    state: "🟢",
    spentMicro: 1_000_000 * i,
    name: `a${i}`,
  });
  const base = {
    month: "settembre 2026",
    spentMicro: 42_000_000,
    waiting: [{ text: "Leo chiede", renderId: 3 }],
    projects: [{ slug: "agentopolis", name: "Agentopolis", channel: "C2" }],
    parked: [{ taskId: 42, text: "Parcheggiata: il pump ignora i canali vuoti" }],
    updatedAt: AT,
  };
  it("renders header, cost (stimato, no budget bar), waiting, projects, agents, parked and the update time", () => {
    const v = homeView({ ...base, agents: [agent(1), agent(2)] }) as {
      type: string;
      blocks: Block[];
    };
    expect(v.type).toBe("home");
    const s = JSON.stringify(v.blocks);
    expect(s).toContain("costo 42.00 $ stimato");
    expect(s).not.toMatch(/budget/i);
    expect(s).toContain("Ti aspettano");
    expect(s).toContain("Apri");
    expect(s).toContain("Vai");
    expect(s).toContain("Parcheggiate");
    expect(s).toContain("Apri come compito");
    expect(s).toContain('"parked_open"');
    expect(s).toContain("Aggiornato alle 18:30");
    expect(s).toContain("Agent 2");
    expect(s).toContain("Assumi");
    expect(s).not.toContain("Costi");
  });
  it("every agent row has the five-entry overflow menu with op:agent values", () => {
    const v = homeView({ ...base, agents: [agent(1)] }) as {
      blocks: (Block & {
        accessory?: { action_id: string; options: { value: string; text: { text: string } }[] };
      })[];
    };
    const row = v.blocks.find((b) => b.accessory?.action_id === "agent_menu");
    expect(row?.accessory?.options.map((o) => o.value)).toEqual([
      "pause:a1",
      "resume:a1",
      "model:a1",
      "restart:a1",
      "retire:a1",
    ]);
    expect(row?.accessory?.options.map((o) => o.text.text)).toEqual([
      "Pausa",
      "Riattiva",
      "Modello",
      "Ricomincia da capo",
      "Licenzia",
    ]);
  });
  it("fits 40 agents (one section each) without a cut", () => {
    const v = homeView({ ...base, agents: Array.from({ length: 40 }, (_, i) => agent(i + 1)) }) as {
      blocks: Block[];
    };
    expect(v.blocks.length).toBeLessThanOrEqual(LIMITS.blocksPerView);
    expect(JSON.stringify(v.blocks)).not.toMatch(/…e altri/);
    expect(JSON.stringify(v.blocks)).toContain("Agent 40");
  });
  it("cuts at 100 blocks with an …e altri N line when the agents do not fit", () => {
    const v = homeView({
      ...base,
      agents: Array.from({ length: 120 }, (_, i) => agent(i + 1)),
    }) as { blocks: Block[] };
    expect(v.blocks.length).toBeLessThanOrEqual(LIMITS.blocksPerView);
    expect(JSON.stringify(v.blocks)).toMatch(/…e altri \d+/);
    expect(JSON.stringify(v.blocks.at(-1))).toContain("Aggiornato alle");
  });
});

describe("edited card and model modal", () => {
  it("editedCard shows the diff line with Vedi differenze and Annulla; undoneCard drops the buttons", () => {
    const c = editedCard({ renderId: 12, agent: "Leo", file: "AGENT.md", added: 3, removed: 1 });
    expect(c.text).toBe("AGENT.md di Leo aggiornato · +3 −1 righe");
    expect(actions(c).map((e) => [e.action_id, e.value])).toEqual([
      ["details", "12:0"],
      ["undo_edit", "Leo"],
    ]);
    const u = undoneCard(c, { agent: "Leo", file: "AGENT.md" });
    expect(blocksOf(u).some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(u.blocks)).toContain("modifica annullata");
  });
  it("modelModal carries the agent and pre-selects the current model", () => {
    const v = modelModal({
      agent: "ceo",
      models: ["opus", "sonnet", "haiku"],
      current: "sonnet",
    }) as {
      callback_id: string;
      private_metadata: string;
      blocks: { element: { initial_option?: { value: string } } }[];
    };
    expect(v.callback_id).toBe("model");
    expect(JSON.parse(v.private_metadata)).toEqual({ agent: "ceo" });
    expect(v.blocks[0]?.element.initial_option?.value).toBe("sonnet");
  });
});

describe("modals", () => {
  const inputs = (v: { blocks: Block[] }) => v.blocks.filter((b) => b.type === "input");
  const meta = (v: { private_metadata?: string }) => v.private_metadata ?? "";
  it("hireModal has at most six inputs, a short title and role options", () => {
    const v = hireModal({
      roles: ["lead", "developer", "scout"],
      projects: ["agentopolis"],
      models: ["opus", "sonnet"],
    }) as {
      title: { text: string };
      blocks: Block[];
      callback_id: string;
      private_metadata?: string;
    };
    expect(v.callback_id).toBe("hire");
    expect(v.title.text.length).toBeLessThanOrEqual(LIMITS.modalTitle);
    expect(inputs(v).length).toBeLessThanOrEqual(6);
    expect(inputs(v).map((b) => b.block_id)).toContain("role");
  });
  it("editModal carries agent and file in private_metadata within the cap", () => {
    const v = editModal({
      agent: "agentopolis-lead",
      file: "AGENT.md",
      initial: "x".repeat(1500),
    }) as { blocks: Block[]; private_metadata?: string; callback_id: string };
    expect(v.callback_id).toBe("edit");
    expect(JSON.parse(meta(v))).toEqual({ agent: "agentopolis-lead", file: "AGENT.md" });
    expect(meta(v).length).toBeLessThanOrEqual(LIMITS.privateMetadata);
    expect(inputs(v)).toHaveLength(1);
  });
  it("replyModal carries the render id and shows the question", () => {
    const v = replyModal({ renderId: 5, question: "Quale colore?" }) as {
      blocks: Block[];
      private_metadata?: string;
      callback_id: string;
    };
    expect(v.callback_id).toBe("reply");
    expect(JSON.parse(meta(v))).toEqual({ renderId: 5 });
    expect(JSON.stringify(v.blocks)).toContain("Quale colore?");
    expect(inputs(v)).toHaveLength(1);
  });
});
