// One loop per agent (spec section 3). A wake during a turn sets the dirty flag and the loop
// runs again, reading everything pending: coalescing for free, and no queue to lose.
// The pending set is a query, so a restart replays wakes without a durable queue.

export type LoopDeps = {
  /** the global concurrency cap; every turn passes through it (spec section 3) */
  limit<T>(fn: () => Promise<T>): Promise<T>;
  /** false when the agent is paused, the plan is limit-paused, or its rung is refused */
  mayRun(agent: string): boolean;
  /** pending messages, or an outcome the agent has not been told about yet */
  hasWork(agent: string): boolean;
  /** everything one turn does: build, spawn, record, deliver */
  runTurn(agent: string): Promise<void>;
  onError?(agent: string, error: unknown): void;
};

export class AgentLoop {
  readonly agent: string;
  readonly #deps: LoopDeps;
  #dirty = false;
  #running = false;
  #idle: Promise<void> = Promise.resolve();
  #stopped = false;
  /** turns actually run, for the tests and /healthz */
  turns = 0;

  constructor(agent: string, deps: LoopDeps) {
    this.agent = agent;
    this.#deps = deps;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Marks work waiting. Never runs two turns for one agent: a wake during a turn coalesces. */
  wake(_reason: string): void {
    if (this.#stopped) return;
    this.#dirty = true;
    if (!this.#running) this.#idle = this.#run();
  }

  /** Resolves when the loop has no turn in flight and nothing dirty left. */
  async settled(): Promise<void> {
    while (this.#running) await this.#idle;
  }

  /** No new turns; a turn in flight is left to finish (the scheduler drains it). */
  stop(): void {
    this.#stopped = true;
    this.#dirty = false;
  }

  async #run(): Promise<void> {
    this.#running = true;
    try {
      while (this.#dirty && !this.#stopped) {
        this.#dirty = false;
        await this.#oneTurn();
      }
    } finally {
      this.#running = false;
    }
  }

  async #oneTurn(): Promise<void> {
    if (!this.#deps.mayRun(this.agent)) return;
    if (!this.#deps.hasWork(this.agent)) return;
    try {
      await this.#deps.limit(async () => {
        // checked again inside the cap: the wait may have been long
        if (!this.#deps.mayRun(this.agent) || !this.#deps.hasWork(this.agent)) return;
        this.turns += 1;
        await this.#deps.runTurn(this.agent);
      });
    } catch (error) {
      // a failed turn must never wedge the loop: the turn row carries the failure
      this.#deps.onError?.(this.agent, error);
    }
  }
}
