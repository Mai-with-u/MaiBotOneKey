import {
  Bot,
  CheckCircle2,
  Loader2,
  RotateCcw,
  ShieldAlert,
  TerminalSquare,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopSnapshot,
  LogEntry,
  PythonOverridesState,
  PythonPackageSourcePreset,
  ServiceDescriptor,
} from "@shared/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Progress } from "@/components/ui/progress";
import { useShortcut } from "@/lib/use-shortcut";

interface InitializationWizardProps {
  snapshot: DesktopSnapshot;
  onSnapshot: (snapshot: DesktopSnapshot) => void;
  onOpenTab: (tab: string) => void;
}

const STARTUP_WIZARD_KEY = "maibot-startup-wizard-seen";
const LOCAL_CHAT_USER_NAME_STORAGE_KEY = "maibot.localChat.userName";
const AUTO_START_DELAY_MS = 2000;
const WEBUI_READY_TIMEOUT_MS = 90_000;
const WEBUI_READY_POLL_MS = 1000;
type WizardStep = "core" | "profile";

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readStartupWizardSeen(): boolean {
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

function readLocalUserName(): string {
  try {
    return localStorage.getItem(LOCAL_CHAT_USER_NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLocalUserName(userName: string): void {
  try {
    localStorage.setItem(LOCAL_CHAT_USER_NAME_STORAGE_KEY, userName);
  } catch {
    // Local storage can be unavailable in isolated previews.
  }
}

function maibotServiceFrom(snapshot: DesktopSnapshot): ServiceDescriptor | undefined {
  return snapshot.services?.find((service) => service.id === "maibot");
}

function dependencyLogs(entries: LogEntry[]): LogEntry[] {
  return entries
    .filter((entry) => entry.source === "maibot" && entry.stream === "system")
    .filter((entry) =>
      entry.message.includes("startup dependency upgrade") ||
      entry.message.includes("dependency") ||
      entry.message.includes("pip"),
    )
    .slice(-8);
}

function serviceProgress(service: ServiceDescriptor | undefined, busy: boolean): number {
  if (service?.status === "running" && service.health === "ready") {
    return 100;
  }
  if (service?.status === "running") {
    return service.health === "checking" ? 88 : 92;
  }
  if (service?.status === "starting" && service.detail?.includes("依赖检查完成")) {
    return 72;
  }
  if (service?.status === "starting") {
    return 42;
  }
  return busy ? 18 : 0;
}

function wizardServiceDetail(service: ServiceDescriptor | undefined, busy: boolean): string {
  if (service?.status === "running" && service.health === "ready") {
    return "MaiCore 已启动，正在进入首次配置";
  }
  if (service?.status === "running" || service?.health === "unreachable") {
    return "等待 MaiCore 启动中";
  }
  if (service?.status === "starting") {
    return service.detail ?? "正在启动 MaiCore";
  }
  return busy ? "正在准备 MaiCore 启动环境" : "正在读取依赖源并准备自动初始化";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function InitializationWizard({
  snapshot,
  onSnapshot,
  onOpenTab,
}: InitializationWizardProps): React.JSX.Element | null {
  const [seen, setSeen] = useState(readStartupWizardSeen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pythonDeps, setPythonDeps] = useState<PythonOverridesState | null>(null);
  const [localUserName, setLocalUserName] = useState(readLocalUserName);
  const [step, setStep] = useState<WizardStep>("core");
  const autoStartRequested = useRef(false);
  const autoStartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agreementPending = !snapshot.startupAgreement.isConfirmed;
  const service = maibotServiceFrom(snapshot);
  const logs = useMemo(() => dependencyLogs(snapshot.recentLogs ?? []), [snapshot.recentLogs]);
  const running = service?.status === "running";
  const ready = running && service?.health === "ready";
  const starting = service?.status === "starting";
  const open = !agreementPending && !seen;
  const progress = serviceProgress(service, busy);

  const refreshSnapshot = useCallback(async () => {
    const nextSnapshot = await window.maibotDesktop?.getSnapshot();
    if (nextSnapshot) {
      onSnapshot(nextSnapshot);
    }
    return nextSnapshot;
  }, [onSnapshot]);

  const waitForMaiBotWebUi = useCallback(async (): Promise<void> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < WEBUI_READY_TIMEOUT_MS) {
      const nextSnapshot = await refreshSnapshot();
      const nextService = nextSnapshot ? maibotServiceFrom(nextSnapshot) : undefined;
      if (nextService?.status === "running" && nextService.health === "ready") {
        return;
      }
      if (nextService?.status === "error") {
        throw new Error(nextService.error ?? nextService.detail ?? "MaiBot Core failed to start");
      }
      await delay(WEBUI_READY_POLL_MS);
    }

    throw new Error("MaiBot WebUI startup timed out; check the terminal page logs");
  }, [refreshSnapshot]);

  const close = useCallback(() => {
    markStartupWizardSeen();
    setSeen(true);
  }, []);

  const startMaiCore = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await window.maibotDesktop?.init.repair();
      await window.maibotDesktop?.services.start("maibot");
      await waitForMaiBotWebUi();
      setStep("profile");
    } catch (nextError) {
      setError(messageFromError(nextError));
      await refreshSnapshot().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [refreshSnapshot, waitForMaiBotWebUi]);

  const saveDependencySource = useCallback(async (preset: PythonPackageSourcePreset) => {
    setError(null);
    if (!busy && !starting && !running) {
      autoStartRequested.current = false;
      if (autoStartTimer.current) {
        clearTimeout(autoStartTimer.current);
        autoStartTimer.current = null;
      }
    }
    try {
      const state = await window.maibotDesktop?.pythonDeps.saveSourcePreset(preset);
      if (state) {
        setPythonDeps(state);
      }
    } catch (nextError) {
      setError(messageFromError(nextError));
    }
  }, [busy, running, starting]);

  const updateLocalUserName = useCallback((value: string) => {
    setLocalUserName(value);
    setError(null);
  }, []);

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
    if (!open || step !== "core" || !pythonDeps || autoStartRequested.current || busy || starting || running) {
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

  const finishProfile = useCallback(() => {
    const userName = localUserName.trim();
    if (!userName) {
      setError("请先填写你自己的用户名。");
      return;
    }
    saveLocalUserName(userName);
    onOpenTab("maibot");
    close();
  }, [close, localUserName, onOpenTab]);

  useShortcut("Escape", close, { enabled: open && !busy, allowInEditable: true });

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) close(); }}>
      <DialogContent
        onPointerDownOutside={(event) => {
          if (busy) {
            event.preventDefault();
          }
        }}
        size="lg"
      >
        <DialogHeader
          icon={<Bot className="size-4" />}
          title="初始化 MaiBot Core"
          tone="default"
        />

        <DialogBody className="space-y-4">
          {step === "core" ? (
            <>
              <section className="rounded-lg border border-border bg-muted/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                      <TerminalSquare className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">MaiBot Core</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        首次启动会检查运行目录、同步基础文件，并按需安装 Python 覆盖依赖。
                      </p>
                    </div>
                  </div>
                  <Badge dot variant={ready ? "success" : running || starting || busy ? "warning" : "secondary"}>
                    {ready ? "WebUI 已就绪" : running ? "等待 WebUI" : starting || busy ? "初始化中" : "即将开始"}
                  </Badge>
                </div>

                <label className="mt-4 grid gap-1.5 text-xs font-medium">
                  依赖源
                  <select
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    disabled={busy || starting || !pythonDeps}
                    onChange={(event) => void saveDependencySource(event.target.value as PythonPackageSourcePreset)}
                    value={pythonDeps?.sourcePreset ?? "tuna"}
                  >
                    {(pythonDeps?.sourceOptions ?? [
                      { preset: "tuna", label: "清华源", url: "https://pypi.tuna.tsinghua.edu.cn/simple" },
                      { preset: "pypi", label: "官方 PyPI", url: "https://pypi.org/simple" },
                      { preset: "aliyun", label: "阿里源", url: "https://mirrors.aliyun.com/pypi/simple" },
                    ]).map((option) => (
                      <option key={option.preset} value={option.preset}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="mt-4 space-y-2">
                  <Progress value={progress} />
                  <p className="text-xs text-muted-foreground">
                    {wizardServiceDetail(service, busy)}
                  </p>
                </div>
              </section>

              <section className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase text-muted-foreground">
                  {ready ? <CheckCircle2 className="size-3.5 text-success" /> : <Loader2 className="size-3.5 animate-spin" />}
                  依赖安装进度
                </div>
                <div className="mt-3 max-h-36 space-y-1 overflow-auto rounded-md border border-border bg-muted/30 p-3">
                  {logs.length > 0 ? (
                    logs.map((entry) => (
                      <p className="font-mono text-[11px] leading-relaxed text-muted-foreground" key={entry.id}>
                        {entry.message}
                      </p>
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      还没有依赖安装日志。初始化开始后，检查、下载和安装输出会出现在这里。
                    </p>
                  )}
                </div>
              </section>
            </>
          ) : (
            <section className="rounded-lg border border-border bg-muted/40 p-4">
              <div className="flex min-w-0 items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                  <Bot className="size-5" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">设置你的用户名</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    这个名称会用于随便聊聊里显示你的本地发送者名称。
                  </p>
                </div>
              </div>
              <label className="mt-4 grid gap-1.5 text-xs font-medium">
                你的用户名
                <Input
                  autoFocus
                  onChange={(event) => updateLocalUserName(event.target.value)}
                  placeholder="例如 小明"
                  value={localUserName}
                />
              </label>
            </section>
          )}

          {error ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
              <ShieldAlert className="size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button disabled={busy} onClick={close} size="sm" variant="ghost">
            稍后再说
            <Kbd className="ml-1" keys="Esc" size="xs" tone="muted" />
          </Button>
          {step === "core" && error && !busy && !starting ? (
            <Button onClick={retry} size="sm">
              <RotateCcw />
              重试
            </Button>
          ) : null}
          {step === "profile" ? (
            <Button onClick={finishProfile} size="sm">
              <CheckCircle2 />
              完成
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
