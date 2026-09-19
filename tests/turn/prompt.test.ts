import { describe, expect, it } from "vitest";
import { buildTurnPrompt, type TurnState } from "../../src/turn/prompt.js";

const state = (over: Partial<TurnState> = {}): TurnState => ({
  agent: "ada",
  role: "lead",
  model: "opus",
  effort: "high",
  containers: ["dm:ada", "agentopolis-hq"],
  openAsks: 0,
  pending: [],
  lastCostMicro: null,
  cacheHitRatio: null,
  ...over,
});

const messages = [
  { id: 3, container: "dm:ada", author: "owner", kind: "say", body: "tre" },
  { id: 1, container: "dm:ada", author: "owner", kind: "ask", body: "uno" },
  { id: 2, container: "agentopolis-hq", author: "jarvis", kind: "report", body: "due" },
];

describe("buildTurnPrompt", () => {
  it("opens with the agent's own state: who it is, its rung, its containers", () => {
    const out = buildTurnPrompt({ state: state(), messages: [], outcomes: [], remembered: [] });
    expect(out).toContain("# Stato");
    expect(out).toContain("Sei ada, ruolo lead.");
    expect(out).toContain("Gradino attuale: opus / high.");
    expect(out).toContain("dm:ada, agentopolis-hq");
  });

  it("counts open asks, names what is pending, and labels the cost as an estimate", () => {
    const out = buildTurnPrompt({
      state: state({
        openAsks: 2,
        pending: [{ what: "richiesta", id: 7, detail: "open_task, in attesa" }],
        lastCostMicro: 1_250_000,
        cacheHitRatio: 0.93,
      }),
      messages: [],
      outcomes: [],
      remembered: [],
    });
    expect(out).toContain("Domande aperte al proprietario: 2.");
    expect(out).toContain("richiesta #7 (open_task, in attesa)");
    expect(out).toContain("1.25 USD stimato");
    expect(out).toContain("Cache usata nell'ultimo turno: 93%.");
  });

  it("says a cost it does not know is unknown, never an estimate", () => {
    const out = buildTurnPrompt({ state: state(), messages: [], outcomes: [], remembered: [] });
    expect(out).toContain("Costo dell'ultimo turno: sconosciuto.");
    expect(out).not.toContain("Cache usata");
  });

  it("groups new messages by container in first-id order, each container in id order", () => {
    const out = buildTurnPrompt({ state: state(), messages, outcomes: [], remembered: [] });
    expect(out).toContain("# Messaggi nuovi");
    expect(out.indexOf("## dm:ada")).toBeLessThan(out.indexOf("## agentopolis-hq"));
    expect(out.indexOf("[#1] owner (ask): uno")).toBeLessThan(out.indexOf("[#3] owner (say): tre"));
    expect(out).toContain("[#2] jarvis (report): due");
  });

  it("omits every section that is empty", () => {
    const out = buildTurnPrompt({ state: state(), messages: [], outcomes: [], remembered: [] });
    expect(out).not.toContain("# Messaggi nuovi");
    expect(out).not.toContain("# Esiti");
    expect(out).not.toContain("# Ricordato da poco");
  });

  it("puts outcomes then remembered lines after the messages", () => {
    const out = buildTurnPrompt({
      state: state(),
      messages,
      outcomes: ["richiesta 4 approvata dal proprietario"],
      remembered: ["il proprietario scrive in italiano"],
    });
    expect(out.indexOf("# Messaggi nuovi")).toBeLessThan(out.indexOf("# Esiti"));
    expect(out.indexOf("# Esiti")).toBeLessThan(out.indexOf("# Ricordato da poco"));
    expect(out).toContain("- richiesta 4 approvata dal proprietario");
    expect(out).toContain("- il proprietario scrive in italiano");
  });

  it("closes by telling the agent the envelope is the answer and a parked deny ends the turn", () => {
    const out = buildTurnPrompt({ state: state(), messages, outcomes: [], remembered: [] });
    const tail = out.trimEnd();
    expect(tail).toMatch(/Rispondi solo con la busta/);
    expect(tail).toMatch(/parcheggiato/);
    expect(tail).toMatch(/risvegliato con la decisione/);
    expect(
      tail.endsWith(
        "Non usare post se non per un messaggio che deve partire prima della fine del turno.",
      ),
    ).toBe(true);
  });

  it("is byte-identical for the same input, whatever order the messages arrive in", () => {
    const a = buildTurnPrompt({
      state: state(),
      messages,
      outcomes: ["o"],
      remembered: ["r"],
    });
    const b = buildTurnPrompt({
      state: state(),
      messages: [...messages].reverse(),
      outcomes: ["o"],
      remembered: ["r"],
    });
    expect(a).toBe(b);
  });
});
