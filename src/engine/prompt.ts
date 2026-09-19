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
