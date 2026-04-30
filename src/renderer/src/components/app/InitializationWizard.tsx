import { Bot, KeyRound, Loader2, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DesktopSnapshot } from "@shared/contracts";
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
import { createSecureToken } from "@/lib/secure-token";
import { useShortcut } from "@/lib/use-shortcut";

interface InitializationWizardProps {
  snapshot: DesktopSnapshot;
  onSnapshot: (snapshot: DesktopSnapshot) => void;
}

const STARTUP_WIZARD_KEY = "maibot-startup-wizard-seen";

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

export function InitializationWizard({
  snapshot,
  onSnapshot,
}: InitializationWizardProps): React.JSX.Element | null {
  const [seen, setSeen] = useState(readStartupWizardSeen);
  const [qqAccount, setQqAccount] = useState(snapshot.initState.qqAccount ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQqAccount(snapshot.initState.qqAccount ?? "");
  }, [snapshot.initState.qqAccount]);

  const agreementPending = !snapshot.startupAgreement.isConfirmed;
  const open = !agreementPending && !seen && !snapshot.initState.qqAccount;

  const refreshSnapshot = useCallback(async () => {
    const nextSnapshot = await window.maibotDesktop?.getSnapshot();
    if (nextSnapshot) {
      onSnapshot(nextSnapshot);
    }
  }, [onSnapshot]);

  const close = useCallback(() => {
    markStartupWizardSeen();
    setSeen(true);
  }, []);

  const saveQqAccount = useCallback(async () => {
    const trimmed = qqAccount.trim();
    if (trimmed.length === 0) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await window.maibotDesktop?.init.setQqAccount(trimmed, createSecureToken());
      await refreshSnapshot();
      close();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(false);
    }
  }, [close, qqAccount, refreshSnapshot]);

  const canSave = !busy && qqAccount.trim().length > 0;

  useShortcut("Escape", close, { enabled: open, allowInEditable: true });
  useShortcut("Mod+Enter", saveQqAccount, { enabled: open && canSave, allowInEditable: true });

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent size="md">
      <DialogHeader
        description="填写机器人账号后会生成 NapCat 与 OneBot 连接配置。"
        icon={<Bot className="size-4" />}
        title="启动向导"
        tone="default"
      />

      <DialogBody className="space-y-4">
        <div className="rounded-lg border border-border bg-muted/40 p-4">
          <label
            className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
            htmlFor="startup-qq-input"
          >
            <KeyRound className="size-3.5" />
            机器人 QQ 号
          </label>
          <Input
            className="mt-3"
            id="startup-qq-input"
            inputMode="numeric"
            monospace
            onChange={(event) => setQqAccount(event.target.value)}
            placeholder="例如 123456789"
            value={qqAccount}
          />
          {error ? (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
              {error}
            </div>
          ) : null}
        </div>
      </DialogBody>

      <DialogFooter>
        <Button onClick={close} size="sm" variant="ghost">
          稍后设置
          <Kbd className="ml-1" keys="Esc" size="xs" tone="muted" />
        </Button>
        <Button disabled={!canSave} onClick={saveQqAccount} size="sm">
          {busy ? <Loader2 className="animate-spin" /> : <Save />}
          保存并继续
          <Kbd className="ml-1" keys="Mod+Enter" size="xs" tone="inverse" />
        </Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
