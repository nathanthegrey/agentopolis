/** Slack limits, in one place; every builder goes through this module. */
export const LIMITS = {
  sectionText: 3000,
  blocksPerMessage: 50,
  blocksPerView: 100,
  buttonText: 75,
  buttonValue: 2000,
  modalTitle: 24,
  privateMetadata: 3000,
  textPerMessage: 40_000,
  msgPerSecondPerChannel: 1,
} as const;

const FENCE = "```";
const CLOSE = "\n```"; // appended to a part that ends inside a code block
const OPEN = "```\n"; // prepended to the following part

const fenceCount = (s: string): number => s.split(FENCE).length - 1;

/** Never cut inside a run of backticks: that would turn a fence into stray backticks. */
function outsideBacktickRun(text: string, cut: number): number {
  let c = cut;
  while (c > 0 && text[c - 1] === "`" && text[c] === "`") c -= 1;
  return c;
}

/** Best cut in [1, limit]: after a paragraph break, else after a line break, else hard. */
function cutPoint(text: string, limit: number): number {
  const para = text.lastIndexOf("\n\n", limit - 2);
  if (para > 0) return para + 2;
  const line = text.lastIndexOf("\n", limit - 1);
  if (line > 0) return line + 1;
  const hard = outsideBacktickRun(text, limit);
  return hard > 0 ? hard : limit;
}

/**
 * Splits text into parts of at most `max` characters, preferring paragraph then line
 * boundaries. A fenced code block that would be cut is closed at the end of the part and
 * reopened at the start of the next, so every part renders on its own.
 */
export function splitText(text: string, max: number = LIMITS.sectionText): string[] {
  // below 12 a cut fence cannot be closed, reopened and still make progress
  if (max < 12) throw new Error(`splitText: max ${max} is too small`);
  const parts: string[] = [];
  let work = text;
  while (work.length > max) {
    let cut = cutPoint(work, max);
    let inFence = fenceCount(work.slice(0, cut)) % 2 === 1;
    if (inFence) {
      // leave room for the closing marker; the reopened remainder grows by OPEN.length,
      // so the cut must land past that: a too-early soft cut becomes a hard one
      const limit = max - CLOSE.length;
      let fenced = cutPoint(work, limit);
      if (fenced <= OPEN.length) fenced = outsideBacktickRun(work, limit) || limit;
      cut = fenced;
      inFence = fenceCount(work.slice(0, cut)) % 2 === 1;
    }
    if (inFence) {
      parts.push(work.slice(0, cut) + CLOSE);
      work = OPEN + work.slice(cut);
    } else {
      parts.push(work.slice(0, cut));
      work = work.slice(cut);
    }
  }
  parts.push(work);
  return parts;
}

/**
 * Slack refuses a payload whose action_ids collide inside a block ("action_id … already
 * exists", invalid_blocks) and whose block_ids collide inside a message or view. We enforce
 * the stricter rule of unique action_ids across the whole payload, so a builder can never
 * produce what the real Slack refuses.
 */
export function assertUniqueIds(blocks: unknown[]): void {
  const blockIds = new Set<string>();
  const actionIds = new Set<string>();
  const seeAction = (el: unknown) => {
    const id = (el as { action_id?: unknown } | null)?.action_id;
    if (typeof id !== "string") return;
    if (actionIds.has(id)) throw new Error(`action_id "${id}" already exists`);
    actionIds.add(id);
  };
  for (const b of blocks) {
    const block = b as { block_id?: unknown; elements?: unknown[]; accessory?: unknown } | null;
    if (typeof block?.block_id === "string") {
      if (blockIds.has(block.block_id))
        throw new Error(`block_id "${block.block_id}" already exists`);
      blockIds.add(block.block_id);
    }
    for (const el of block?.elements ?? []) seeAction(el);
    if (block?.accessory) seeAction(block.accessory);
  }
}

/**
 * Slack refuses an empty `value` on a button and on the options of an overflow or select
 * ("must be more than 0 characters", invalid_arguments). Found live on 2026-09-19.
 */
export class EmptyValueError extends Error {}
export function assertValues(blocks: unknown[]): void {
  const check = (el: unknown, where: string) => {
    const e = el as { type?: string; value?: unknown; options?: { value?: unknown }[] } | null;
    if (!e) return;
    if (e.type === "button" && (typeof e.value !== "string" || e.value.length === 0)) {
      throw new EmptyValueError(`button at ${where} has an empty value`);
    }
    for (const [i, o] of (e.options ?? []).entries()) {
      if (typeof o.value !== "string" || o.value.length === 0) {
        throw new EmptyValueError(`option ${i} of ${e.type} at ${where} has an empty value`);
      }
    }
  };
  for (const [i, b] of blocks.entries()) {
    const block = b as { elements?: unknown[]; accessory?: unknown } | null;
    for (const [j, el] of (block?.elements ?? []).entries()) check(el, `blocks/${i}/elements/${j}`);
    if (block?.accessory) check(block.accessory, `blocks/${i}/accessory`);
  }
}

export function assertBlocks(blocks: unknown[], max: number): void {
  if (blocks.length > max) {
    throw new Error(`${blocks.length} blocks exceed the Slack cap of ${max}`);
  }
  assertUniqueIds(blocks);
  assertValues(blocks);
}

export function truncateButton(text: string): string {
  const max = LIMITS.buttonText;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A status line in a task thread is edited at most this often (spec section 9). */
export const STATUS_LINE_EDIT_MS = 30_000;

/**
 * Per-method budgets under Slack's tiers, per app (spec section 9 [field]). A family key
 * ("conversations.*") covers every method of that family. Methods not listed are unbudgeted
 * here and rely on Slack's own 429 + Retry-After.
 */
export const METHOD_BUDGETS_PER_MINUTE: Readonly<Record<string, number>> = {
  "chat.update": 50,
  "conversations.*": 40,
  "chat.appendStream": 160,
};

export function budgetKeyFor(method: string): string | undefined {
  if (method in METHOD_BUDGETS_PER_MINUTE) return method;
  const family = `${method.split(".")[0]}.*`;
  return family in METHOD_BUDGETS_PER_MINUTE ? family : undefined;
}

export type BudgetDecision = { ok: true } | { ok: false; retryAfterMs: number };

/** Sliding one-minute window per budget key; `take` counts the call when it is allowed. */
export class MethodBudget {
  readonly #now: () => number;
  readonly #windowMs: number;
  readonly #calls = new Map<string, number[]>();

  constructor(now: () => number, windowMs = 60_000) {
    this.#now = now;
    this.#windowMs = windowMs;
  }

  take(method: string): BudgetDecision {
    const key = budgetKeyFor(method);
    if (!key) return { ok: true };
    const limit = METHOD_BUDGETS_PER_MINUTE[key] ?? Number.POSITIVE_INFINITY;
    const now = this.#now();
    const recent = (this.#calls.get(key) ?? []).filter((t) => now - t < this.#windowMs);
    if (recent.length >= limit) {
      const oldest = recent[0] ?? now;
      this.#calls.set(key, recent);
      return { ok: false, retryAfterMs: Math.max(1, oldest + this.#windowMs - now) };
    }
    recent.push(now);
    this.#calls.set(key, recent);
    return { ok: true };
  }
}
