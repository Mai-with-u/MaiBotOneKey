export function normalizeQqAccount(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const account = value.trim();
  return /^\d+$/u.test(account) && !/^0+$/u.test(account) ? account : undefined;
}
