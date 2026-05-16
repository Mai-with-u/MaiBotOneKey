import {
  Bot,
  Filter,
  KeyRound,
  ListChecks,
  Loader2,
  Save,
  ShieldAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DesktopSnapshot,
  NapcatAdapterChatConfig,
  NapcatChatListMode,
  QqBackend,
} from "@shared/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useShortcut } from "@/lib/use-shortcut";
import { cn } from "@/lib/utils";
import { IdListEditor } from "./IdListEditor";

interface InitializationWizardProps {
  snapshot: DesktopSnapshot;
  onSnapshot: (snapshot: DesktopSnapshot) => void;
}

const STARTUP_WIZARD_KEY = "maibot-startup-wizard-seen";

const DEFAULT_CHAT_CONFIG: NapcatAdapterChatConfig = {
  enableChatListFilter: true,
  showDroppedChatListMessages: false,
  groupListType: "whitelist",
  groupList: [],
  privateListType: "whitelist",
  privateList: [],
  banUserId: [],
  banQqBot: false,
};

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

interface ListModeFieldProps {
  label: string;
  value: NapcatChatListMode;
  onChange: (value: NapcatChatListMode) => void;
  name: string;
}

function ListModeField({ label, value, onChange, name }: ListModeFieldProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] font-medium text-foreground">{label}</span>
      <RadioGroup
        className="flex items-center gap-3"
        name={name}
        onValueChange={(next) => onChange(next as NapcatChatListMode)}
        value={value}
      >
        <label className="flex items-center gap-1.5 text-[12px] text-foreground">
          <RadioGroupItem value="whitelist" /> 白名单
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-foreground">
          <RadioGroupItem value="blacklist" /> 黑名单
        </label>
      </RadioGroup>
    </div>
  );
}

export function InitializationWizard({
  snapshot,
  onSnapshot,
}: InitializationWizardProps): React.JSX.Element | null {
  const [seen, setSeen] = useState(readStartupWizardSeen);
  const [qqAccount, setQqAccount] = useState(snapshot.initState.qqAccount ?? "");
  const [qqBackend, setQqBackend] = useState<QqBackend>(snapshot.initState.qqBackend ?? "napcat");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chat, setChat] = useState<NapcatAdapterChatConfig>(DEFAULT_CHAT_CONFIG);
  const services = snapshot.services ?? [];
  const runtimeSwitchBlocked = services.some(
    (service) =>
      service.status === "starting" ||
      service.status === "running" ||
      service.status === "stopping",
  );

  useEffect(() => {
    setQqAccount(snapshot.initState.qqAccount ?? "");
    setQqBackend(snapshot.initState.qqBackend ?? "napcat");
  }, [snapshot.initState.qqAccount, snapshot.initState.qqBackend]);

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

  const updateChat = useCallback(
    <K extends keyof NapcatAdapterChatConfig>(key: K, value: NapcatAdapterChatConfig[K]) => {
      setChat((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const saveQqAccount = useCallback(async () => {
    const trimmed = qqAccount.trim();
    if (trimmed.length === 0) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await window.maibotDesktop?.init.setQqAccount({
        qqAccount: trimmed,
        qqBackend,
        chat,
      });
      await refreshSnapshot();
      close();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(false);
    }
  }, [chat, close, qqAccount, qqBackend, refreshSnapshot]);

  const canSave = !busy && qqAccount.trim().length > 0;

  useShortcut("Escape", close, { enabled: open, allowInEditable: true });
  useShortcut("Mod+Enter", saveQqAccount, { enabled: open && canSave, allowInEditable: true });

  const filterDisabled = !chat.enableChatListFilter;

  const description = useMemo(
    () => "填写机器人账号后会自动生成 NapCat 与 OneBot 连接配置。",
    [],
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent
        onPointerDownOutside={(event) => event.preventDefault()}
        size="lg"
      >
        <DialogHeader
          description={description}
          icon={<Bot className="size-4" />}
          title="启动向导"
          tone="default"
        />

        <DialogBody className="space-y-5">
          <section className="rounded-lg border border-border bg-muted/40 p-4">
            <label
              className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
              htmlFor="startup-qq-input"
            >
              <KeyRound className="size-3.5" />
              机器人 QQ 号
            </label>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {([
                { value: "napcat", label: "NapCat", description: "使用 NapCat 启动 QQ 与 OneBot 连接。" },
                { value: "snowluma", label: "SnowLuma", description: "使用 SnowLuma 注入 QQ 进程。" },
              ] as const).map((option) => (
                <button
                  className={cn(
                    "rounded-md border p-3 text-left transition-colors",
                    runtimeSwitchBlocked &&
                      qqBackend !== option.value &&
                      "cursor-not-allowed opacity-55",
                    qqBackend === option.value
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
                  )}
                  disabled={runtimeSwitchBlocked && qqBackend !== option.value}
                  key={option.value}
                  onClick={() => setQqBackend(option.value)}
                  type="button"
                >
                  <span className="text-sm font-semibold">{option.label}</span>
                  <span className="mt-1 block text-xs leading-relaxed">{option.description}</span>
                </button>
              ))}
            </div>
            <Input
              className="mt-3"
              id="startup-qq-input"
              inputMode="numeric"
              monospace
              onChange={(event) => setQqAccount(event.target.value)}
              placeholder="例如 123456789"
              value={qqAccount}
            />
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              保存后会向 NapCat 写入端口 7998 的正向 WebSocket 服务；如果当前 MaiBot 已安装
              napcat-adapter，会同步写入同一个 token。
            </p>
            {runtimeSwitchBlocked ? (
              <p className="mt-2 text-[11px] leading-relaxed text-warning">
                MaiBot Core 或 QQ 后端运行中，暂不能切换 NapCat / SnowLuma。请先停止全部服务。
              </p>
            ) : null}
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <header className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <ListChecks className="size-3.5" />
              群聊 / 私聊名单
            </header>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              当前 MaiBot 已存在 napcat-adapter 时，名单设置会同步写入它的 <code className="rounded bg-muted px-1 py-0.5 text-[10.5px]">config.toml</code>。
            </p>

            <div className="mt-3 grid gap-3">
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={chat.enableChatListFilter}
                  id="wiz-enable-filter"
                  onCheckedChange={(next) => updateChat("enableChatListFilter", Boolean(next))}
                />
                <span className="flex flex-col text-[12px] text-foreground">
                  启用群聊 / 私聊名单过滤
                  <span className="text-[11px] text-muted-foreground">
                    关闭时仍会应用全局屏蔽用户与官方机器人屏蔽设置。
                  </span>
                </span>
              </label>

              <div
                className={cn(
                  "grid gap-3 rounded-md border border-dashed border-border bg-background/40 p-3",
                  filterDisabled && "pointer-events-none opacity-60",
                )}
              >
                <ListModeField
                  label="群聊名单模式"
                  name="wiz-group-mode"
                  onChange={(value) => updateChat("groupListType", value)}
                  value={chat.groupListType}
                />
                <IdListEditor
                  emptyHint="暂未添加群号，留空表示不命中名单"
                  label="群聊名单（群号）"
                  onChange={(next) => updateChat("groupList", next)}
                  placeholder="输入群号后回车添加"
                  values={chat.groupList}
                />
                <ListModeField
                  label="私聊名单模式"
                  name="wiz-private-mode"
                  onChange={(value) => updateChat("privateListType", value)}
                  value={chat.privateListType}
                />
                <IdListEditor
                  emptyHint="暂未添加私聊用户"
                  label="私聊名单（用户 ID）"
                  onChange={(next) => updateChat("privateList", next)}
                  placeholder="输入用户 QQ 号后回车添加"
                  values={chat.privateList}
                />
              </div>

              <label className="flex items-start gap-2">
                <Checkbox
                  checked={chat.banQqBot}
                  id="wiz-ban-bot"
                  onCheckedChange={(next) => updateChat("banQqBot", Boolean(next))}
                />
                <span className="flex flex-col text-[12px] text-foreground">
                  屏蔽 QQ 官方机器人 / 频道机器人
                  <span className="text-[11px] text-muted-foreground">
                    开启后会忽略来自官方机器人的消息事件。
                  </span>
                </span>
              </label>
            </div>
          </section>

          {error ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
              <ShieldAlert className="size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
            <Filter className="size-3.5 shrink-0" />
            稍后想要修改？打开顶部「插件」标签页，在插件管理中找到对应插件即可调整配置。
          </p>
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
