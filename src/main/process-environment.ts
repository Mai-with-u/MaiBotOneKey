/** Windows environment names are case-insensitive, including when overrides use PATH instead of Path. */
export function mergeProcessEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
  platform = process.platform,
): Record<string, string> {
  const entries = new Map<string, [string, string]>();
  for (const source of [base, overrides]) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) entries.set(platform === "win32" ? key.toUpperCase() : key, [key, value]);
    }
  }
  return Object.fromEntries(entries.values());
}
