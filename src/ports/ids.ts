import { randomUUID } from "node:crypto";

export interface Ids {
  uuid(): string;
}

export class SystemIds implements Ids {
  uuid(): string {
    return randomUUID();
  }
}

export class FakeIds implements Ids {
  #queue: string[];
  constructor(seed: string[]) {
    this.#queue = [...seed];
  }
  uuid(): string {
    const next = this.#queue.shift();
    if (next === undefined) throw new Error("FakeIds: exhausted");
    return next;
  }
}
