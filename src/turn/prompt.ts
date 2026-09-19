// What a turn reads (spec section 6). The daemon builds this; nothing an agent could read about
// itself is a tool, because every tool call is one more full-context API request. The text is
// deterministic: the same input gives the same bytes, so a repeated turn hits the prompt cache.
import { formatUsd } from "../money.js";

export type TurnMessage = {
  id: number;
  container: string;
  author: string;
  kind: string;
  body: string;
};

export type PendingItem = {
  /** "richiesta" or "permesso" */
  what: string;
  id: number;
  detail: string;
};

export type TurnState = {
  agent: string;
  role: string;
  model: string;
  effort: string | undefined;
  /** container names the agent belongs to, as the envelope must name them */
  containers: string[];
  /** unanswered asks from this agent to the owner */
  openAsks: number;
  pending: PendingItem[];
  lastCostMicro: number | null;
  /** cache_read / input of the last turn, or null when there was none */
  cacheHitRatio: number | null;
};

export type TurnPromptInput = {
  state: TurnState;
  messages: TurnMessage[];
  outcomes: string[];
  remembered: string[];
};

const CLOSING = [
  "Rispondi solo con la busta: i messaggi che mandi sono il risultato del turno.",
  "Se un permesso torna negato dicendo che è parcheggiato, chiudi qui il turno con la busta:",
  "sarai risvegliato con la decisione del proprietario.",
  "Non usare post se non per un messaggio che deve partire prima della fine del turno.",
].join("\n");

const section = (heading: string, body: string): string => `${heading}\n\n${body.trim()}\n`;

function stateLines(s: TurnState): string {
  const lines = [
    `- Sei ${s.agent}, ruolo ${s.role}.`,
    `- Gradino attuale: ${s.model}${s.effort ? ` / ${s.effort}` : ""}.`,
    `- Container di cui fai parte: ${s.containers.length ? s.containers.join(", ") : "nessuno"}.`,
    `- Domande aperte al proprietario: ${s.openAsks}.`,
  ];
  lines.push(
    s.pending.length === 0
      ? "- In attesa: niente."
      : `- In attesa: ${s.pending.map((p) => `${p.what} #${p.id} (${p.detail})`).join(", ")}.`,
  );
  lines.push(
    s.lastCostMicro === null
      ? "- Costo dell'ultimo turno: sconosciuto."
      : `- Costo dell'ultimo turno: ${formatUsd(s.lastCostMicro)} USD stimato.`,
  );
  if (s.cacheHitRatio !== null) {
    lines.push(`- Cache usata nell'ultimo turno: ${Math.round(s.cacheHitRatio * 100)}%.`);
  }
  return lines.join("\n");
}

export function buildTurnPrompt(input: TurnPromptInput): string {
  const blocks: string[] = [section("# Stato", stateLines(input.state))];

  if (input.messages.length > 0) {
    const sorted = [...input.messages].sort((a, b) => a.id - b.id);
    const byContainer = new Map<string, TurnMessage[]>();
    for (const m of sorted) {
      const list = byContainer.get(m.container) ?? [];
      list.push(m);
      byContainer.set(m.container, list);
    }
    const parts: string[] = [];
    for (const [container, list] of byContainer) {
      const lines = list.map((m) => `[#${m.id}] ${m.author} (${m.kind}): ${m.body}`).join("\n");
      parts.push(section(`## ${container}`, lines));
    }
    blocks.push(section("# Messaggi nuovi", parts.join("\n")));
  }

  if (input.outcomes.length > 0) {
    blocks.push(section("# Esiti", input.outcomes.map((o) => `- ${o}`).join("\n")));
  }
  if (input.remembered.length > 0) {
    blocks.push(section("# Ricordato da poco", input.remembered.map((r) => `- ${r}`).join("\n")));
  }
  blocks.push(`${CLOSING}\n`);
  return blocks.join("\n");
}
