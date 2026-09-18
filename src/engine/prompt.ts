import type { Role } from "../config/loader.js";

const section = (heading: string, body: string): string => `${heading}\n\n${body.trim()}\n`;

export function composeSystemPrompt(style: string, role: Role): string {
  return [
    section("# Style", style),
    section("# Who you are", role.soul),
    section("# Your job", role.job),
    section("# How you work with others", role.protocol),
  ].join("\n");
}

export function composeFirstUserMessage(parts: {
  memory: string;
  knowledge: { name: string; text: string }[];
  state: string | undefined;
}): string {
  const knowledge = [...parts.knowledge]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((k) => section(`## ${k.name}`, k.text))
    .join("\n");
  const out = [section("# Memory", parts.memory), section("# Project knowledge", knowledge)];
  if (parts.state !== undefined) out.push(section("# State pack", parts.state));
  return out.join("\n");
}

export type TurnMessage = {
  id: number;
  container: string;
  author: string;
  kind: string;
  body: string;
};

export function composeTurnPrompt(input: {
  messages: TurnMessage[];
  outcomes: string[];
  remembered: string[];
}): string {
  const sorted = [...input.messages].sort((a, b) => a.id - b.id);
  const byContainer = new Map<string, TurnMessage[]>();
  for (const m of sorted) {
    const list = byContainer.get(m.container) ?? [];
    list.push(m);
    byContainer.set(m.container, list);
  }
  const blocks: string[] = [];
  for (const [container, list] of byContainer) {
    const lines = list.map((m) => `[#${m.id}] ${m.author} (${m.kind}): ${m.body}`).join("\n");
    blocks.push(section(`## ${container}`, lines));
  }
  if (input.outcomes.length) {
    blocks.push(section("# Outcomes", input.outcomes.map((o) => `- ${o}`).join("\n")));
  }
  if (input.remembered.length) {
    blocks.push(
      section("# Remembered since last turn", input.remembered.map((r) => `- ${r}`).join("\n")),
    );
  }
  blocks.push("Rispondi solo tramite gli strumenti agentopolis; non scrivere testo libero.\n");
  return blocks.join("\n");
}
