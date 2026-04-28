import { AlertTriangle, CheckCircle2, Loader2, Save, Wrench } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DesktopSnapshot, InitCheckStatus } from "@shared/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { useShortcut } from "@/lib/use-shortcut";

interface InitializationWizardProps {
  snapshot: DesktopSnapshot;
  onSnapshot: (snapshot: DesktopSnapshot) => void;
}

const DISMISS_KEY = "maibot-init-wizard-dismissed";

const checkVariant: Record<InitCheckStatus, ComponentProps<typeof Badge>["variant"]> = {
  ok: "success",
  warning: "warning",
  error: "danger",
};

const checkLabel: Record<InitCheckStatus, string> = {
  ok: "正常",
  warning: "需确认",
  error: "缺失",
};

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function InitializationWizard({
  snapshot,
  onSnapshot,
}: InitializationWizardProps): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [qqAccount, setQqAccount] = useState(snapshot.initState.qqAccount ?? "");
  const [busy, setBusy] = useState<"repair" | "qq" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQqAccount(snapshot.initState.qqAccount ?? "");
  }, [snapshot.initState.qqAccount]);

  const checksNeedingAttention = useMemo(
    () => snapshot.initState.checks.filter((check) => check.status !== "ok"),
    [snapshot.initState.checks],
  );
  const needsAttention = checksNeedingAttention.length > 0;
  const open = needsAttention && !dismissed;

  const refreshSnapshot = useCallback(async () => {
    const nextSnapshot = await window.maibotDesktop?.getSnapshot();
    if (nextSnapshot) {
      onSnapshot(nextSnapshot);
    }
  }, [onSnapshot]);

  const dismiss = useCallback(() => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Session storage can be unavailable in isolated previews.
    }
    setDismissed(true);
  }, []);

  const repair = useCallback(async () => {
    setBusy("repair");
    setError(null);
    try {
      await window.maibotDesktop?.init.repair();
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [refreshSnapshot]);

  const saveQqAccount = useCallback(async () => {
    const trimmed = qqAccount.trim();
    if (trimmed.length === 0) {
      return;
    }
    setBusy("qq");
    setError(null);
    try {
      await window.maibotDesktop?.init.setQqAccount(trimmed);
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [qqAccount, refreshSnapshot]);

  const canSave = busy === null && qqAccount.trim().length > 0;

  useShortcut("Escape", dismiss, { enabled: open, allowInEditable: true });
  useShortcut("Mod+Enter", saveQqAccount, { enabled: open && canSave, allowInEditable: true });
  useShortcut("Mod+Shift+R", repair, { enabled: open && busy === null });

  return (
    <Dialog
      ariaLabelledBy="init-wizard-title"
      onClose={dismiss}
      open={open}
      showCloseButton
      size="lg"
    >
      <DialogHeader
        description="先确认内置 runtime、模块、基础配置和依赖完整性；依赖损坏只提示错误，不自动修复。"
        icon={<AlertTriangle className="size-4" />}
        title="首次初始化检查"
        titleId="init-wizard-title"
        tone="warning"
      />

      <DialogBody className="grid gap-5 md:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-h-0 rounded-lg border border-border/70 bg-muted/30">
          <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2.5">
            <span className="text-xs font-semibold text-foreground">检查项</span>
            <Badge variant={snapshot.initState.isReady ? "warning" : "danger"}>
              {checksNeedingAttention.length} 项待处理
            </Badge>
          </div>
          <div className="max-h-80 overflow-y-auto p-2">
            {snapshot.initState.checks.map((check) => (
              <div
                className="flex items-start gap-2 rounded-md px-2 py-2 text-xs"
                key={check.id}
              >
                <CheckCircle2
                  className={
                    check.status === "ok"
                      ? "mt-0.5 size-3.5 shrink-0 text-emerald-600"
                      : "mt-0.5 size-3.5 shrink-0 text-amber-600"
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{check.label}</span>
                    <Badge variant={checkVariant[check.status]}>{checkLabel[check.status]}</Badge>
                  </div>
                  <p
                    className="mt-1 truncate text-[11px] text-muted-foreground"
                    title={check.path}
                  >
                    {check.detail}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-lg border border-border/70 bg-panel/70 p-3">
            <label
              className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
              htmlFor="init-qq-input"
            >
              机器人 QQ 号
            </label>
            <Input
              className="mt-2"
              id="init-qq-input"
              inputMode="numeric"
              monospace
              onChange={(event) => setQqAccount(event.target.value)}
              placeholder="例如 123456789"
              value={qqAccount}
            />
            <Button
              className="mt-3 w-full justify-between"
              disabled={!canSave}
              onClick={saveQqAccount}
              size="sm"
            >
              <span className="flex items-center gap-2">
                {busy === "qq" ? <Loader2 className="animate-spin" /> : <Save />}
                保存 QQ 配置
              </span>
              <Kbd keys="Mod+Enter" size="xs" tone="inverse" />
            </Button>
          </div>

          <Button
            className="w-full justify-between"
            disabled={busy !== null}
            onClick={repair}
            size="sm"
            variant="outline"
          >
            <span className="flex items-center gap-2">
              {busy === "repair" ? <Loader2 className="animate-spin" /> : <Wrench />}
              从模板修复配置
            </span>
            <Kbd keys="Mod+Shift+R" size="xs" tone="muted" />
          </Button>

          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs leading-relaxed text-destructive">
              {error}
            </div>
          ) : null}
        </div>
      </DialogBody>

      <DialogFooter>
        <Button onClick={dismiss} size="sm" variant="ghost">
          稍后处理
          <Kbd className="ml-1" keys="Esc" size="xs" tone="muted" />
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
