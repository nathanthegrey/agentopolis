const SECRET_SHAPES = [/^xox[abp]-/, /^xapp-/];

export function looksLikeSecret(value: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(value));
}

export function findSecrets(obj: unknown, path = ""): string[] {
  if (typeof obj === "string") return looksLikeSecret(obj) ? [path] : [];
  if (Array.isArray(obj)) return obj.flatMap((v, i) => findSecrets(v, `${path}[${i}]`));
  if (obj && typeof obj === "object") {
    return Object.entries(obj).flatMap(([k, v]) => findSecrets(v, path ? `${path}.${k}` : k));
  }
  return [];
}
