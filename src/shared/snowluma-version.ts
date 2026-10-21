/** Compare published SemVer versions; unknown versions never suggest an upgrade. */
export function isSnowLumaUpgradeAvailable(local?: string, bundled?: string): boolean {
  const parse = (value?: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value?.trim() ?? "");
  const current = parse(local);
  const target = parse(bundled);
  if (!current || !target) return false;
  for (let i = 1; i <= 3; i++) {
    const difference = Number(target[i]) - Number(current[i]);
    if (difference) return difference > 0;
  }
  if (!target[4] || !current[4]) return Boolean(current[4]) && !target[4];
  const a = target[4].split(".");
  const b = current[4].split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === undefined || b[i] === undefined) return a[i] !== undefined;
    const an = /^\d+$/u.test(a[i]);
    const bn = /^\d+$/u.test(b[i]);
    if (an && bn) return Number(a[i]) > Number(b[i]);
    if (an !== bn) return !an;
    return a[i] > b[i];
  }
  return false;
}
