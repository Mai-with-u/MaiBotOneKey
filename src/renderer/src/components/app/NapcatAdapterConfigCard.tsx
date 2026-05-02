import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  PlugZap,
  RefreshCw,
  Save,
  Settings2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import type {
  NapcatAdapterConfig,
  NapcatAdapterConfigState,
  NapcatChatListMode,
} from "../../../../shared/contracts";
import { IdListEditor } from "./IdListEditor";

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ListModeFieldProps {
  label: string;
  name: string;
  value: NapcatChatListMode;
  onChange: (value: NapcatChatListMode) => void;
}

function ListModeField({ label, name, value, onChange }: ListModeFieldProps): React.JSX.Element {
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

interface NumberFieldProps {
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  step?: number;
}

function NumberField({ label, hint, value, onChange, min, step }: NumberFieldProps): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-foreground">{label}</span>
      <Input
        inputMode="decimal"
        monospace
        min={min}
        onChange={(event) => {
          const next = Number.parseFloat(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        step={step}
        type="number"
        value={Number.isFinite(value) ? value : 0}
      />
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function NapcatAdapterConfigCard(): React.JSX.Element {
  const [state, setState] = useState<NapcatAdapterConfigState | null>(null);
  const [config, setConfig] = useState<NapcatAdapterConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!window.maibotDesktop?.napcatAdapter) return;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await window.maibotDesktop.napcatAdapter.getConfig();
      setState(next);
      setConfig(next.config);
    } catch (error) {
      setLoadError(messageFromError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateConfig = useCallback(
    (updater: (prev: NapcatAdapterConfig) => NapcatAdapterConfig) => {
      setConfig((prev) => (prev ? updater(prev) : prev));
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!config || !window.maibotDesktop?.napcatAdapter) return;

    setSaving(true);
    try {
      const result = await window.maibotDesktop.napcatAdapter.saveConfig(config);
      setConfig(result.config);
      setSavedAt(result.savedAt);
      setState((prev) =>
        prev
          ? { ...prev, exists: true, config: result.config, configPath: result.configPath }
          : prev,
      );
      toast.success("napcat-adapter 配置已保存", {
        description: result.configPath,
      });
    } catch (error) {
      toast.error("保存失败", { description: messageFromError(error) });
    } finally {
      setSaving(false);
    }
  }, [config]);

  const handleReset = useCallback(() => {
    if (state) {
      setConfig(state.config);
    }
  }, [state]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
              <PlugZap className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <CardTitle>NapCat 适配器配置</CardTitle>
              <CardDescription>正在读取 napcat-adapter 插件配置…</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> 加载中
        </CardContent>
      </Card>
    );
  }

  if (loadError || !config || !state) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-destructive/12 text-destructive">
              <AlertTriangle className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <CardTitle>NapCat 适配器配置</CardTitle>
              <CardDescription>
                {loadError ?? "未能读取 napcat-adapter 配置"}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Button onClick={load} size="sm" variant="ghost">
            <RefreshCw /> 重试
          </Button>
        </CardContent>
      </Card>
    );
  }

  const filterDisabled = !config.chat.enableChatListFilter;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
            <PlugZap className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle>NapCat 适配器配置</CardTitle>
            <CardDescription>
              可视化编辑 napcat-adapter 插件的连接、聊天名单与消息过滤设置。保存后会写入
              <code className="mx-1 rounded bg-muted px-1 py-0.5 text-[10.5px]">
                {state.configPath}
              </code>
              ，下次启动 MaiBot 时生效。
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <section className="grid gap-3 rounded-md border border-border bg-background/40 p-3">
          <header className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            <Settings2 className="size-3.5" /> 插件
          </header>
          <label className="flex items-start gap-2">
            <Checkbox
              checked={config.plugin.enabled}
              onCheckedChange={(next) =>
                updateConfig((prev) => ({
                  ...prev,
                  plugin: { ...prev.plugin, enabled: Boolean(next) },
                }))
              }
            />
            <span className="flex flex-col text-[12px] text-foreground">
              启用 NapCat 适配器
              <span className="text-[11px] text-muted-foreground">
                关闭后插件将保持空闲，不会主动连接 NapCat。
              </span>
            </span>
          </label>
        </section>

        <section className="grid gap-3 rounded-md border border-border bg-background/40 p-3">
          <header className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            NapCat 连接
          </header>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-foreground">主机地址</span>
              <Input
                monospace
                onChange={(event) =>
                  updateConfig((prev) => ({
                    ...prev,
                    server: { ...prev.server, host: event.target.value },
                  }))
                }
                placeholder="127.0.0.1"
                value={config.server.host}
              />
            </label>
            <NumberField
              hint="对应 NapCat 正向 WebSocket 监听端口"
              label="端口"
              min={1}
              onChange={(next) =>
                updateConfig((prev) => ({
                  ...prev,
                  server: { ...prev.server, port: Math.max(1, Math.floor(next)) },
                }))
              }
              step={1}
              value={config.server.port}
            />
            <label className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-[12px] font-medium text-foreground">访问 Token</span>
              <Input
                monospace
                onChange={(event) =>
                  updateConfig((prev) => ({
                    ...prev,
                    server: { ...prev.server, token: event.target.value },
                  }))
                }
                placeholder="保存 QQ 号时会自动同步 NapCat 的 token"
                value={config.server.token}
              />
              <span className="text-[11px] text-muted-foreground">
                需要与 NapCat 的 onebot11 配置中的 token 一致。
              </span>
            </label>
            <NumberField
              label="心跳间隔（秒）"
              min={1}
              onChange={(next) =>
                updateConfig((prev) => ({
                  ...prev,
                  server: { ...prev.server, heartbeatInterval: next },
                }))
              }
              step={1}
              value={config.server.heartbeatInterval}
            />
            <NumberField
              label="重连等待（秒）"
              min={1}
              onChange={(next) =>
                updateConfig((prev) => ({
                  ...prev,
                  server: { ...prev.server, reconnectDelaySec: next },
                }))
              }
              step={1}
              value={config.server.reconnectDelaySec}
            />
            <NumberField
              label="动作超时（秒）"
              min={1}
              onChange={(next) =>
                updateConfig((prev) => ({
                  ...prev,
                  server: { ...prev.server, actionTimeoutSec: next },
                }))
              }
              step={1}
              value={config.server.actionTimeoutSec}
            />
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-foreground">连接标识</span>
              <Input
                monospace
                onChange={(event) =>
                  updateConfig((prev) => ({
                    ...prev,
                    server: { ...prev.server, connectionId: event.target.value },
                  }))
                }
                placeholder="例如 primary，可留空"
                value={config.server.connectionId}
              />
            </label>
          </div>
        </section>

        <section className="grid gap-3 rounded-md border border-border bg-background/40 p-3">
          <header className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            聊天过滤
          </header>
          <label className="flex items-start gap-2">
            <Checkbox
              checked={config.chat.enableChatListFilter}
              onCheckedChange={(next) =>
                updateConfig((prev) => ({
                  ...prev,
                  chat: { ...prev.chat, enableChatListFilter: Boolean(next) },
                }))
              }
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
              name="napcat-group-mode"
              onChange={(value) =>
                updateConfig((prev) => ({
                  ...prev,
                  chat: { ...prev.chat, groupListType: value },
                }))
              }
              value={config.chat.groupListType}
            />
            <IdListEditor
              emptyHint="暂未添加群号"
              label="群聊名单（群号）"
              onChange={(next) =>
                updateConfig((prev) => ({
                  ...prev,
                  chat: { ...prev.chat, groupList: next },
                }))
              }
              placeholder="输入群号后回车添加"
              values={config.chat.groupList}
            />
            <ListModeField
              label="私聊名单模式"
              name="napcat-private-mode"
              onChange={(value) =>
                updateConfig((prev) => ({
                  ...prev,
                  chat: { ...prev.chat, privateListType: value },
                }))
              }
              value={config.chat.privateListType}
            />
            <IdListEditor
              emptyHint="暂未添加私聊用户"
              label="私聊名单（用户 ID）"
              onChange={(next) =>
                updateConfig((prev) => ({
                  ...prev,
                  chat: { ...prev.chat, privateList: next },
                }))
              }
              placeholder="输入用户 QQ 号后回车添加"
              values={config.chat.privateList}
            />
          </div>
          <IdListEditor
            emptyHint="未配置全局屏蔽用户"
            label="全局屏蔽用户"
            onChange={(next) =>
              updateConfig((prev) => ({
                ...prev,
                chat: { ...prev.chat, banUserId: next },
              }))
            }
            placeholder="输入要屏蔽的 QQ 号后回车添加"
            values={config.chat.banUserId}
          />
          <label className="flex items-start gap-2">
            <Checkbox
              checked={config.chat.banQqBot}
              onCheckedChange={(next) =>
                updateConfig((prev) => ({
                  ...prev,
                  chat: { ...prev.chat, banQqBot: Boolean(next) },
                }))
              }
            />
            <span className="flex flex-col text-[12px] text-foreground">
              屏蔽 QQ 官方机器人 / 频道机器人
              <span className="text-[11px] text-muted-foreground">
                开启后会忽略来自官方机器人的消息事件。
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <Checkbox
              checked={config.chat.showDroppedChatListMessages}
              onCheckedChange={(next) =>
                updateConfig((prev) => ({
                  ...prev,
                  chat: { ...prev.chat, showDroppedChatListMessages: Boolean(next) },
                }))
              }
            />
            <span className="flex flex-col text-[12px] text-foreground">
              显示被名单过滤丢弃的消息日志
              <span className="text-[11px] text-muted-foreground">
                默认关闭以减少终端刷屏，调试名单时可以打开。
              </span>
            </span>
          </label>
        </section>

        <section className="grid gap-3 rounded-md border border-border bg-background/40 p-3">
          <header className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            消息过滤
          </header>
          <label className="flex items-start gap-2">
            <Checkbox
              checked={config.filters.ignoreSelfMessage}
              onCheckedChange={(next) =>
                updateConfig((prev) => ({
                  ...prev,
                  filters: { ...prev.filters, ignoreSelfMessage: Boolean(next) },
                }))
              }
            />
            <span className="flex flex-col text-[12px] text-foreground">
              忽略机器人自身发送的消息
              <span className="text-[11px] text-muted-foreground">
                建议保持开启，避免机器人处理自己刚刚发出的消息。
              </span>
            </span>
          </label>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {savedAt ? (
              <>
                <CheckCircle2 className="size-3.5 text-success" />
                已于 {new Date(savedAt).toLocaleTimeString()} 保存
              </>
            ) : (
              <>
                {state.exists ? (
                  <>已存在配置，编辑后点击保存即可写入磁盘。</>
                ) : (
                  <>尚未生成 config.toml，保存即可创建并启用插件。</>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              disabled={saving}
              onClick={handleReset}
              size="sm"
              variant="ghost"
            >
              <RefreshCw /> 还原
            </Button>
            <Button disabled={saving} onClick={handleSave} size="sm">
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              保存配置
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
