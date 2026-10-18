let activeTransition: ViewTransition | null = null;

/** Capture before confirmation so IPC snapshot events join the same scene change. */
export async function transitionStartupScene(update: () => Promise<void>): Promise<void> {
  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    await update();
    return;
  }
  // Consecutive startup stages should finish their shape change before the next.
  if (activeTransition) await activeTransition.finished.catch(() => undefined);
  const transition = document.startViewTransition(update);
  activeTransition = transition;
  // An interrupted animation must not turn a successful confirmation into an error.
  void transition.ready.catch(() => undefined);
  const release = () => { if (activeTransition === transition) activeTransition = null; };
  void transition.finished.then(release, release);
  await transition.updateCallbackDone;
}
