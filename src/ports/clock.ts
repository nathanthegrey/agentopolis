export interface Clock {
  now(): number; // epoch milliseconds UTC
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class FakeClock implements Clock {
  #t: number;
  constructor(start: number) {
    this.#t = start;
  }
  now(): number {
    return this.#t;
  }
  advance(ms: number): void {
    this.#t += ms;
  }
}
