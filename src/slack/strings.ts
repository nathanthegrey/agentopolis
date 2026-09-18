// Every string the owner reads in Slack, in one place (spec principle 7: Italian to the owner).
import { formatUsd } from "../money.js";

export const S = {
  asks: (persona: string) => `${persona} chiede`,
  confirm: "Conferma",
  choose: "Scegli…",
  chosen: (choice: string, by: string, hhmm: string) =>
    `✅ Scelto: ${choice} · da ${by} alle ${hhmm}`,
  approve: "Approva",
  approveTask: "Approva per questo compito",
  deny: "Nega",
  details: "Dettagli",
  reopen: "Riapri",
  denyConfirmTitle: "Sei sicuro?",
  denyConfirmText: "Questa azione è distruttiva e non si può annullare.",
  yes: "Sì",
  no: "No",
  decided: {
    approvato: (by: string, hhmm: string) => `✅ Approvato · da ${by} alle ${hhmm}`,
    negato: (by: string, hhmm: string) => `⛔️ Negato · da ${by} alle ${hhmm}`,
    scaduta: () => "⏸️ Scaduta: nessuno ha risposto, l'ho trattata come un no",
  },
  working: (display: string, dur: string) => `${display} sta lavorando · ${dur}`,
  finished: (display: string, dur: string, cost: string) =>
    `${display} ha finito · ${dur} · ${cost}`,
  costEstimated: (micro: number) => `${formatUsd(micro)} $ stimato`,
  costUnknown: "costo sconosciuto",
  reply: "Rispondi",
  replyTitle: "Rispondi",
  replyLabel: "La tua risposta",
  send: "Invia",
  cancel: "Annulla",
  task: {
    state: (state: string) => `${STATE_GLYPH[state] ?? "▫️"} ${state}`,
    cost: (micro: number | null) =>
      micro === null ? "costo sconosciuto" : `costo ${formatUsd(micro)} $ stimato`,
    agents: (list: string[]) => (list.length ? `agenti: ${list.join(", ")}` : "nessun agente"),
  },
  home: {
    title: "Agentopolis",
    spend: (month: string, spent: number) => `${month} · costo ${formatUsd(spent)} $ stimato`,
    waiting: "Ti aspettano",
    nothingWaiting: "Niente in attesa.",
    open: "Apri",
    projects: "Progetti",
    go: "Vai",
    agents: "Agenti",
    hire: "Assumi",
    costs: "Costi",
    updated: (hhmm: string) => `Aggiornato alle ${hhmm}`,
    more: (n: number) => `…e altri ${n}`,
    agentLine: (display: string, state: string, spent: number) =>
      `${state} *${display}* · ${formatUsd(spent)} $`,
    overflow: { pause: "Pausa", model: "Modello", fire: "Licenzia" },
  },
  hire: {
    title: "Assumi un agente",
    role: "Ruolo",
    project: "Progetto",
    display: "Nome mostrato",
    model: "Modello",
    submit: "Assumi",
  },
  edit: {
    title: (file: string) => `Modifica ${file}`.slice(0, 24),
    label: "Testo",
    submit: "Salva",
  },
  usage:
    "Comandi: /agentopolis, /hire, /edit <agente>, /pause <agente>, /resume <agente>, /model <agente> <modello>, /costs, /pulse, /diag <agente>, /rollback",
  staleCard: "Questa card è stata superata: guarda quella più recente.",
  unknownAgent: (name: string) => `Non conosco l'agente "${name}".`,
  unknownRole: (name: string) => `Ruolo sconosciuto: ${name}`,
  required: "Campo obbligatorio",
  notANumber: "Serve un numero positivo",
  failed: "Non ci sono riuscito",
  paused: (agent: string) => `⏸️ ${agent} è in pausa.`,
  resumed: (agent: string) => `🟢 ${agent} è di nuovo attivo.`,
  modelSet: (agent: string, model: string) => `🟢 ${agent} userà ${model} dal prossimo turno.`,
  rolledBack: "🟢 Modifica annullata.",
  useHireToFire:
    "Per licenziare usa il menu dell'agente in Home dopo la fetta 6; per ora metti in pausa.",
  duration: (seconds: number) =>
    seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`,
} as const;

const STATE_GLYPH: Record<string, string> = {
  fatto: "🟢",
  "in corso": "🟡",
  bloccato: "🔴",
  "in pausa": "⏸️",
  domanda: "💬",
  aperto: "🟡",
  review: "🟡",
  chiuso: "🟢",
};

export function hhmm(at: number, tz = "Europe/Rome"): string {
  return new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  }).format(new Date(at));
}
