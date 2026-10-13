import type { MaiBotSetupStatus } from "@shared/contracts";

/** Poll serially and keep waiting through startup, token rotation, and transient failures. */
export function watchSetupCompletion(
  readStatus: () => Promise<MaiBotSetupStatus>,
  onComplete: () => void,
  intervalMs = 1_500,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    let status: MaiBotSetupStatus | undefined;
    try { status = await readStatus(); } catch { /* A failed read is not completion. */ }
    if (cancelled) return;
    if (status === "complete") {
      cancelled = true;
      onComplete();
      return;
    }
    timer = setTimeout(() => { void check(); }, intervalMs);
  };
  void check();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
