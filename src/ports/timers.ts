/**
 * Waiting, behind a port. A permission is held for minutes (D1) and an approval expires after
 * hours (spec section 10); neither may make a test wait, and neither may be a bare setTimeout
 * the daemon cannot cancel at shutdown.
 */
export interface Timers {
  /** Runs fn after ms. The returned function cancels it. */
  after(ms: number, fn: () => void): () => void;
}

export class SystemTimers implements Timers {
  after(ms: number, fn: () => void): () => void {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return () => clearTimeout(handle);
  }
}

/** Fires only when the test says so. */
export class FakeTimers implements Timers {
  #now = 0;
  #next = 1;
  readonly #pending = new Map<number, { at: number; fn: () => void }>();

  after(ms: number, fn: () => void): () => void {
    const id = this.#next++;
    this.#pending.set(id, { at: this.#now + ms, fn });
    return () => this.#pending.delete(id);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Advances the clock and fires everything due, in time order. */
  advance(ms: number): void {
    this.#now += ms;
    for (;;) {
      const due = [...this.#pending.entries()]
        .filter(([, t]) => t.at <= this.#now)
        .sort((a, b) => a[1].at - b[1].at);
      const first = due[0];
      if (!first) return;
      this.#pending.delete(first[0]);
      first[1].fn();
    }
  }
}
