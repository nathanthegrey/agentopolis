const MICRO = 1_000_000;

export function toMicroUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`toMicroUsd: invalid amount ${usd}`);
  }
  return Math.round(usd * MICRO);
}

export function formatUsd(micro: number): string {
  return (micro / MICRO).toFixed(2);
}
