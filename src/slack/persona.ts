import { type Chat, ChatError, type Persona, type PostArgs, type Posted } from "../ports/chat.js";

/**
 * Persona identity degrades when a scope is missing (spec section 9): username + icon_url,
 * then icon_emoji, then bare username, then plain. The level that worked is remembered for
 * the process (one app, one set of scopes).
 */
export type PersonaLevel = "icon_url" | "icon_emoji" | "username" | "plain";
const ORDER: PersonaLevel[] = ["icon_url", "icon_emoji", "username", "plain"];
const SCOPE_ERRORS = new Set(["missing_scope", "invalid_arguments", "not_allowed_token_type"]);

let level: PersonaLevel = "icon_url";

export function currentPersonaLevel(): PersonaLevel {
  return level;
}

export function resetPersonaLevel(to: PersonaLevel = "icon_url"): void {
  level = to;
}

function shape(persona: Persona, at: PersonaLevel): Persona | undefined {
  switch (at) {
    case "icon_url":
      return persona.iconUrl ? { username: persona.username, iconUrl: persona.iconUrl } : undefined;
    case "icon_emoji":
      return persona.iconEmoji
        ? { username: persona.username, iconEmoji: persona.iconEmoji }
        : undefined;
    case "username":
      return { username: persona.username };
    case "plain":
      return undefined;
  }
}

export async function postAsPersona(
  chat: Chat,
  args: PostArgs & { persona: Persona },
): Promise<Posted> {
  const { persona, ...rest } = args;
  let lastError: unknown;
  for (let i = ORDER.indexOf(level); i < ORDER.length; i += 1) {
    const at = ORDER[i] as PersonaLevel;
    const shaped = shape(persona, at);
    // a level the persona cannot fill (no icon given) is skipped without a call
    if (shaped === undefined && at !== "plain") continue;
    try {
      const posted = await chat.post(shaped ? { ...rest, persona: shaped } : rest);
      level = at;
      return posted;
    } catch (e) {
      if (e instanceof ChatError && SCOPE_ERRORS.has(e.code)) {
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  throw lastError ?? new ChatError("persona post failed", "unknown");
}
