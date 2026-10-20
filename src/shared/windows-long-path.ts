/** Require explicit long-path evidence; a missing file alone has many causes. */
export function isWindowsLongPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /pip\.pypa\.io\/warnings\/enable-long-paths|(?:Windows\s+Long\s+Path\s+support|system does not have.*Long Path)|WinError\s*206|ENAMETOOLONG|filename or extension is too long/iu.test(message);
}
