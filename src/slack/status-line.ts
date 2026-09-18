import { STATUS_LINE_EDIT_MS } from "./limits.js";

/**
 * "Leo sta lavorando · 2 min" is edited in place at most once every 30 s per line (spec
 * section 9): three tasks at one edit per second would be 180 chat.update a minute against
 * Slack's 50. The daemon asks `allow(key)` before each edit; a refused edit is simply skipped,
 * the next allowed one carries the current duration.
 */
export class StatusLineThrottle {
  readonly #now: () => number;
  readonly #minMs: number;
  readonly #last = new Map<string, number>();

  constructor(now: () => number, minMs = STATUS_LINE_EDIT_MS) {
    this.#now = now;
    this.#minMs = minMs;
  }

  /** key: the line's channel:ts */
  allow(key: string): boolean {
    const now = this.#now();
    const last = this.#last.get(key);
    if (last !== undefined && now - last < this.#minMs) return false;
    this.#last.set(key, now);
    return true;
  }

  forget(key: string): void {
    this.#last.delete(key);
  }
}
