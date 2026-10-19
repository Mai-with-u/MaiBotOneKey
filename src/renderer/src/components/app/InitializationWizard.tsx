import { getDesktopSnapshot } from "@/lib/desktop-api";
import { watchSetupCompletion } from "@/lib/setup-completion";
import { canRestartDependencyDownload, initializationStatus } from "@/lib/initialization-status";
import {
  Loader2,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { transitionStartupScene } from "@/lib/startup-transition";
import type {
  DesktopSnapshot,
  LogEntry,
  MaiBotModuleUpdateProgress,
  PythonEnvironmentState,
  PythonPackageSourcePreset,
  ServiceDescriptor,
} from "@shared/contracts";
import { Button } from "@/components/ui/button";
import { InitializationPage } from "./InitializationPage";

interface InitializationWizardProps {
  snapshot: DesktopSnapshot;
  onSnapshot: (snapshot: DesktopSnapshot) => void;
  onOpenTab: (tab: string) => void;
  onPreparingChange: (preparing: boolean) => void;
  webuiState: "loading" | "ready" | "error";
  onReloadWebui: () => void;
}

const STARTUP_WIZARD_KEY = "maibot-startup-wizard-seen";
const AUTO_START_DELAY_MS = 2000;
const WEBUI_READY_TIMEOUT_MS = 90_000;
const WEBUI_READY_POLL_MS = 1000;
type WizardStep = "core" | "webui";

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readStartupWizardSeen(): boolean {
  try {
    return localStorage.getItem(STARTUP_WIZARD_KEY) === "1";
  } catch {
    return false;
  }
}

function markStartupWizardSeen(): void {
  try {
    localStorage.setItem(STARTUP_WIZARD_KEY, "1");
  } catch {
    // Local storage can be unavailable in isolated previews.
  }
}

function maibotServiceFrom(
  snapshot: DesktopSnapshot,
): ServiceDescriptor | undefined {
  return snapshot.services?.find((service) => service.id === "maibot");
}

function dependencyLogs(entries: LogEntry[]): LogEntry[] {
  return entries
    .filter((entry) => entry.source === "maibot" && entry.stream === "system")
    .filter(
      (entry) =>
        entry.message.includes("startup dependency upgrade") ||
        entry.message.includes("MaiBot preparation:") ||
        entry.message.includes("dependency") ||
        entry.message.includes("pip"),
    )
    .slice(-200);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function InitializationWizard({
  snapshot,
  onSnapshot,
  onOpenTab,
  onPreparingChange,
  webuiState,
  onReloadWebui,
}: InitializationWizardProps): React.JSX.Element | null {
  const [seen, setSeen] = useState(readStartupWizardSeen);
  const [busy, setBusy] = useState(false);
  const [preparation, setPreparation] = useState<MaiBotModuleUpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pythonDeps, setPythonDeps] = useState<PythonEnvironmentState | null>(
    null,
  );
  const [sourceSaving, setSourceSaving] = useState(false);
  const [downloadRestarting, setDownloadRestarting] = useState(false);
  const [step, setStep] = useState<WizardStep>("core");
  const [statusEllipsis, setStatusEllipsis] = useState("");
  const autoStartRequested = useRef(false);
  const autoStartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startupRunId = useRef(0);
  const handingOff = useRef(false);
  const agreementPending = !snapshot.startupAgreement.isConfirmed;
  const service = maibotServiceFrom(snapshot);
  const logs = useMemo(
    () => dependencyLogs(snapshot.recentLogs ?? []),
    [snapshot.recentLogs],
  );
  const running = service?.status === "running";
  const ready = running && service?.health === "ready";
  const starting = service?.status === "starting";
  const statusAnimating = busy || starting || (running && (!ready || webuiState === "loading"));
  const open = !agreementPending && !seen;
  const status = ready && webuiState !== "ready"
    ? { progress: 96, detail: "正在加载 MaiBot 首页" }
    : initializationStatus(service, busy, preparation);
  const restartDownloadVisible = step === "core" && canRestartDependencyDownload(service, preparation);

  useEffect(() => {
    if (!open || step !== "core") return;
    return window.maibotDesktop?.modules.onMaiBotUpdateProgress(setPreparation);
  }, [open, step]);

  useEffect(() => {
    if (step !== "core" || !statusAnimating) {
      setStatusEllipsis("");
      return;
    }

    let count = 0;
    const timer = window.setInterval(() => {
      count = (count + 1) % 4;
      setStatusEllipsis(".".repeat(count));
    }, 450);

    return () => window.clearInterval(timer);
  }, [statusAnimating, step]);

  const refreshSnapshot = useCallback(async () => {
    const nextSnapshot = await getDesktopSnapshot();
    onSnapshot(nextSnapshot);
    return nextSnapshot;
  }, [onSnapshot]);

  const waitForMaiBotWebUi = useCallback(async (): Promise<void> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < WEBUI_READY_TIMEOUT_MS) {
      const nextSnapshot = await refreshSnapshot();
      const nextService = maibotServiceFrom(nextSnapshot);
      if (nextService?.status === "running" && nextService.health === "ready") {
        return;
      }
      if (nextService?.status === "error") {
        throw new Error(
          nextService.error ??
            nextService.detail ??
            "MaiBot Core failed to start",
        );
      }
      await delay(WEBUI_READY_POLL_MS);
    }

    throw new Error(
      "MaiBot WebUI startup timed out; check the terminal page logs",
    );
  }, [refreshSnapshot]);

  const close = useCallback(() => {
    markStartupWizardSeen();
    setSeen(true);
  }, []);
  const runMaiCoreStartup = useCallback(
    async ({
      repairFirst,
      startService,
    }: {
      repairFirst: boolean;
      startService: () => Promise<void>;
    }) => {
      const runId = startupRunId.current + 1;
      startupRunId.current = runId;
      setBusy(true);
      setPreparation(null);
      setError(null);
      try {
        if (repairFirst) {
          await window.maibotDesktop?.init.repair();
          if (startupRunId.current !== runId) {
            return;
          }
        }
        await startService();
        if (startupRunId.current !== runId) {
          return;
        }
        await waitForMaiBotWebUi();
      } catch (nextError) {
        if (startupRunId.current === runId) {
          setError(messageFromError(nextError));
          await refreshSnapshot().catch(() => undefined);
        }
      } finally {
        if (startupRunId.current === runId) {
          setBusy(false);
        }
      }
    },
    [refreshSnapshot, waitForMaiBotWebUi],
  );

  const startMaiCore = useCallback(async () => {
    await runMaiCoreStartup({
      repairFirst: true,
      startService: async () => {
        await window.maibotDesktop?.services.start("maibot");
      },
    });
  }, [runMaiCoreStartup]);

  const restartDependencyDownload = useCallback(async () => {
    autoStartRequested.current = true;
    setDownloadRestarting(true);
    try {
      await runMaiCoreStartup({
        repairFirst: false,
        startService: async () => {
          await window.maibotDesktop?.services.restart("maibot");
        },
      });
    } finally {
      setDownloadRestarting(false);
    }
  }, [runMaiCoreStartup]);

  const saveDependencySource = useCallback(
    async (preset: PythonPackageSourcePreset) => {
      setError(null);
      if (!busy && !starting && !running) {
        autoStartRequested.current = false;
        if (autoStartTimer.current) {
          clearTimeout(autoStartTimer.current);
          autoStartTimer.current = null;
        }
      }
      setSourceSaving(true);
      try {
        const state =
          await window.maibotDesktop?.pythonDeps.saveSourcePreset(preset);
        if (state) {
          setPythonDeps(state);
        }
      } catch (nextError) {
        setError(messageFromError(nextError));
      } finally {
        setSourceSaving(false);
      }
    },
    [busy, running, starting],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    let mounted = true;
    window.maibotDesktop?.pythonDeps
      .getState()
      .then((state) => {
        if (mounted) {
          setPythonDeps(state);
        }
      })
      .catch((nextError: unknown) => {
        if (mounted) {
          setError(messageFromError(nextError));
        }
      });

    return () => {
      mounted = false;
    };
  }, [open]);

  useEffect(() => {
    if (
      !open ||
      step !== "core" ||
      !pythonDeps ||
      autoStartRequested.current ||
      busy ||
      starting ||
      running
    ) {
      return;
    }

    autoStartRequested.current = true;
    autoStartTimer.current = setTimeout(() => {
      void startMaiCore();
    }, AUTO_START_DELAY_MS);

    return () => {
      if (autoStartTimer.current) {
        clearTimeout(autoStartTimer.current);
        autoStartTimer.current = null;
      }
    };
  }, [busy, open, pythonDeps, running, startMaiCore, starting, step]);

  const retry = useCallback(() => {
    autoStartRequested.current = true;
    void startMaiCore();
  }, [startMaiCore]);

  useEffect(() => {
    if (!open || step !== "core" || !ready || webuiState !== "ready" || handingOff.current) return;
    handingOff.current = true;
    let cancelled = false;
    // Defer outside the effect so reduced-motion fallback can also flush safely.
    void Promise.resolve().then(() => transitionStartupScene(async () => {
      if (cancelled) return;
      flushSync(() => {
        onOpenTab("maibot");
        setStep("webui");
      });
    })).catch((nextError: unknown) => {
      if (cancelled) return;
      handingOff.current = false;
      setError(messageFromError(nextError));
    });
    return () => { cancelled = true; handingOff.current = false; };
  }, [onOpenTab, open, ready, step, webuiState]);

  useEffect(() => {
    if (!open || step !== "webui" || !ready) return;
    const init = window.maibotDesktop?.init;
    if (typeof init?.getMaiBotSetupStatus !== "function") return;
    return watchSetupCompletion(() => init.getMaiBotSetupStatus(), close);
  }, [close, open, ready, step]);

  useLayoutEffect(() => {
    onPreparingChange(!seen && step === "core");
  }, [onPreparingChange, seen, step]);

  // MaiBot owns its setup UI; no host overlay or duplicate completion button.
  if (!open || step === "webui") return null;

  const sourceSelector = (
                  <select
                    aria-label="Python 依赖源"
                    className="h-8 w-24 max-w-[8rem] shrink-0 rounded-md border border-input bg-background px-2 text-xs font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    disabled={
                      !pythonDeps ||
                      sourceSaving ||
                      downloadRestarting ||
                      running
                    }
                    onChange={(event) =>
                      void saveDependencySource(
                        event.target.value as PythonPackageSourcePreset,
                      )
                    }
                    value={pythonDeps?.sourcePreset ?? "tuna"}
                  >
                    {(
                      pythonDeps?.sourceOptions ?? [
                        {
                          preset: "tuna",
                          label: "清华源",
                          url: "https://pypi.tuna.tsinghua.edu.cn/simple",
                        },
                        {
                          preset: "pypi",
                          label: "官方 PyPI",
                          url: "https://pypi.org/simple",
                        },
                        {
                          preset: "aliyun",
                          label: "阿里源",
                          url: "https://mirrors.aliyun.com/pypi/simple",
                        },
                      ]
                    ).map((option) => (
                      <option key={option.preset} value={option.preset}>
                        {option.label}
                      </option>
                    ))}
                  </select>
  );

  return (
    <InitializationPage
      status={`${status.detail}${statusAnimating ? statusEllipsis : ""}`}
      progress={status.progress}
      active={statusAnimating}
      error={error || (ready && webuiState === "error" ? "MaiBot 首页加载失败，请重新加载。" : service?.status === "error" ? service.error || service.detail || "MaiBot 启动失败" : null)}
      sourceSelector={sourceSelector}
      logs={logs}
      actions={restartDownloadVisible || (error && !busy && !starting) || (ready && webuiState === "error") ? <>
        {ready && webuiState === "error" ? <Button onClick={onReloadWebui} size="sm"><RotateCcw />重新加载首页</Button> : null}
        {restartDownloadVisible ? <Button disabled={!pythonDeps || sourceSaving || downloadRestarting} onClick={() => void restartDependencyDownload()} size="sm" variant="outline">
          {downloadRestarting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          {downloadRestarting ? "正在重新下载" : "重新开始下载"}
        </Button> : null}
        {error && !busy && !starting ? <Button onClick={retry} size="sm"><RotateCcw />重试</Button> : null}
      </> : undefined}
    />
  );
}
