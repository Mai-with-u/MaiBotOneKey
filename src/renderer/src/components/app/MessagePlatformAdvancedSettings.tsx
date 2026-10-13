import { normalizeQqAccount } from "@shared/qq-account";
import { Download, Loader2, RefreshCw, Save, Settings } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { DesktopSnapshot, MessagePlatformLoginInfo, QqBackend } from "@shared/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isValidPortText, readQqWebuiPort, saveQqWebuiPort } from "@/lib/qq-webui-port";
import { cn } from "@/lib/utils";

const qqBackendOptions: Array<{ value: QqBackend; label: string }> = [
  { value: "napcat", label: "NapCat" },
  { value: "snowluma", label: "SnowLuma" },
];

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MessagePlatformAdvancedSettings({ snapshot, refreshSnapshot, disabled }: {
  snapshot: DesktopSnapshot;
  refreshSnapshot: () => Promise<void>;
  disabled: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [loginInfo, setLoginInfo] = useState<MessagePlatformLoginInfo | null>(null);
  const [loginInfoError, setLoginInfoError] = useState<string | null>(null);
  const [qqAccounts, setQqAccounts] = useState<Record<QqBackend, string>>({ napcat: "", snowluma: "" });
  const [snowLumaPassword, setSnowLumaPassword] = useState("");
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoginInfo(null);
    setLoginInfoError(null);
    const load = async () => {
      try {
        const info = await window.maibotDesktop?.protocols.getLoginInfo();
        if (!info) throw new Error("无法读取登录信息");
        if (!cancelled) {
          setLoginInfo(info);
          setQqAccounts({ napcat: info.napcat.qqAccount ?? "", snowluma: info.snowluma.qqAccount ?? "" });
          setSnowLumaPassword(info.snowluma.webuiToken ?? "");
        }
      } catch (error) {
        if (!cancelled) setLoginInfoError(messageFromError(error));
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [open]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmQqComponentsUpgradeOpen, setConfirmQqComponentsUpgradeOpen] = useState(false);
  const readBackendPort = (backend: QqBackend): string => readQqWebuiPort(backend,
    backend === snapshot.initState.qqBackend ? snapshot.services.find((service) => service.id === "napcat")?.url : undefined);
  const [qqWebuiPorts, setQqWebuiPorts] = useState<Record<QqBackend, string>>(() => ({
    napcat: readBackendPort("napcat"), snowluma: readBackendPort("snowluma"),
  }));
  const qqComponentsChangeBlocked = snapshot.services.some((service) =>
    service.id === "napcat" && (service.managed || service.status === "starting" || service.status === "running" || service.status === "stopping"),
  );
  const qqWebuiPortsDirty = qqWebuiPorts.napcat !== readBackendPort("napcat") || qqWebuiPorts.snowluma !== readBackendPort("snowluma");
  const qqWebuiPortsValid = isValidPortText(qqWebuiPorts.napcat) && isValidPortText(qqWebuiPorts.snowluma);
  const snowLumaPasswordDirty = loginInfo !== null && snowLumaPassword !== (loginInfo.snowluma.webuiToken ?? "");
  const snowLumaRunning = snapshot.initState.qqBackend === "snowluma" && snapshot.services.some((service) =>
    service.id === "napcat" && (service.managed || ["starting", "running", "stopping"].includes(service.status)),
  );
  const qqBackendRunning = snapshot.services.some((service) =>
    service.id === "napcat" && (service.managed || ["starting", "running", "stopping"].includes(service.status)),
  );
  const saveQqAccount = async (backend: QqBackend) => {
    const account = normalizeQqAccount(qqAccounts[backend]);
    if (!account) {
      setError("请输入正确的 QQ 号");
      return;
    }
    setBusy(`${backend}:account`);
    setError(null);
    try {
      const bridge = window.maibotDesktop;
      if (!bridge) throw new Error("无法连接启动器");
      await bridge.protocols.saveQqBackendAccount(backend, account);
      setLoginInfo((current) => current ? { ...current, [backend]: { ...current[backend], qqAccount: account } } : current);
      setQqAccounts((current) => ({ ...current, [backend]: account }));
      await refreshSnapshot();
      toast.success("QQ 账号已保存，下次启动将使用新账号");
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  };
  const saveSnowLumaPassword = async () => {
    setBusy("snowluma:password");
    setError(null);
    try {
      const bridge = window.maibotDesktop;
      if (!bridge) throw new Error("无法连接启动器");
      await bridge.protocols.saveSnowLumaWebuiPassword(snowLumaPassword);
      setLoginInfo((current) => current ? { ...current, snowluma: { ...current.snowluma, webuiToken: snowLumaPassword } } : current);
      toast.success("SnowLuma WebUI 密码已保存，下次启动将使用新密码自动登录");
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  };
  const upgradeQqComponents = useCallback(async () => {
    if (qqComponentsChangeBlocked) {
      setError("请先停止 QQ 协议端，再重新安装 NapCat / SnowLuma。");
      return;
    }

    setBusy("qq-components:upgrade");
    setError(null);
    try {
      const result = await window.maibotDesktop?.protocols.upgradeQqComponents();
      setConfirmQqComponentsUpgradeOpen(false);
      const preservedCount = result?.components.reduce((total, component) => total + component.preservedEntries.length, 0) ?? 0;
      toast.success(`NapCat / SnowLuma 已重新安装，保留 ${preservedCount} 项配置与数据`);
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [qqComponentsChangeBlocked, refreshSnapshot]);

  const saveQqWebuiPorts = useCallback(() => {
    if (!qqWebuiPortsValid) {
      setError("请填写 1-65535 之间的 NapCat / SnowLuma WebUI 端口。");
      return;
    }

    setError(null);
    const napcat = saveQqWebuiPort("napcat", qqWebuiPorts.napcat);
    const snowluma = saveQqWebuiPort("snowluma", qqWebuiPorts.snowluma);
    setQqWebuiPorts({ napcat, snowluma });
    toast.success("消息平台 WebUI 端口已保存");
  }, [qqWebuiPorts.napcat, qqWebuiPorts.snowluma, qqWebuiPortsValid]);

  const syncConnections = async () => {
    setBusy("qq-connections:sync");
    setError(null);
    try {
      const bridge = window.maibotDesktop;
      if (!bridge) throw new Error("无法连接启动器");
      await bridge.adapters.syncQqConnections();
      await refreshSnapshot();
      toast.success("MaiBot 适配器连接配置已保存");
    } catch (error) {
      setError(messageFromError(error));
    } finally {
      setBusy(null);
    }
  };

  const setAdapterEnabled = async (enabled: boolean) => {
    setBusy("adapter:enabled");
    setError(null);
    try {
      const bridge = window.maibotDesktop;
      if (!bridge) throw new Error("无法连接启动器");
      await bridge.adapters.setEnabled(snapshot.initState.qqProtocol === "official" ? "official" : "onebot", enabled);
      toast.success(enabled ? "适配器已启用" : "适配器已停用");
      await refreshSnapshot();
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Button disabled={disabled || busy !== null} onClick={() => {
        setQqWebuiPorts({ napcat: readBackendPort("napcat"), snowluma: readBackendPort("snowluma") });
        setError(null);
        setOpen(true);
      }} size="sm" variant="outline">
        <Settings />高级设置
      </Button>
      <Dialog open={open} onOpenChange={(next) => { if (busy === null) setOpen(next); }}>
        <DialogContent aria-describedby={undefined} className="grid-rows-[minmax(0,1fr)_auto]" size="lg">
          <DialogTitle className="sr-only">消息平台高级设置</DialogTitle>
          <DialogBody className="space-y-4 pt-12">
            {error && !confirmQqComponentsUpgradeOpen ? <p className="text-xs text-destructive">{error}</p> : null}
            <Tabs defaultValue="ports" className="space-y-4">
              <TabsList className="flex h-auto flex-wrap">
                <TabsTrigger value="ports">WebUI 端口</TabsTrigger>
                <TabsTrigger value="connections">连接配置</TabsTrigger>
                <TabsTrigger value="reinstall">重新安装</TabsTrigger>
              </TabsList>
              <TabsContent value="ports" className="space-y-4">
                <div className="settings-section grid gap-3 bg-muted/40 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">消息平台 WebUI 端口</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        消息平台页面会按这里保存的端口打开 NapCat / SnowLuma WebUI。
                      </p>
                    </div>
                    <Button
                      disabled={busy !== null || !qqWebuiPortsDirty || !qqWebuiPortsValid}
                      onClick={saveQqWebuiPorts}
                      size="sm"
                    >
                      <Save className="size-4" />
                      保存端口
                    </Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {qqBackendOptions.map((option) => {
                      const port = qqWebuiPorts[option.value];
                      const valid = isValidPortText(port);

                      return (
                        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground" key={option.value}>
                          {option.label} WebUI
                          <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
                            <span className="font-mono text-xs text-muted-foreground">127.0.0.1:</span>
                            <Input
                              className={cn("h-8 w-24 font-mono text-sm", !valid && "border-destructive")}
                              disabled={busy !== null}
                              inputMode="numeric"
                              max={65535}
                              min={1}
                              onChange={(event) => {
                                const value = event.target.value.replace(/\D/gu, "").slice(0, 5);
                                setQqWebuiPorts((current) => ({ ...current, [option.value]: value }));
                              }}
                              type="number"
                              value={port}
                            />
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div className="settings-section grid gap-3 bg-muted/40 p-3">
                  <p className="text-sm font-medium">协议端登录信息</p>
                  {loginInfoError ? <p className="text-xs text-destructive">{loginInfoError}</p> : !loginInfo ? (
                    <p className="text-xs text-muted-foreground">正在读取登录信息…</p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {qqBackendOptions.map(({ value, label }) => (
                        <div className="grid min-w-0 gap-3" key={value}>
                          <p className="text-sm font-medium">{label}</p>
                          <label className="grid gap-1.5 text-xs text-muted-foreground">
                            {value === "snowluma" ? "WebUI 登录 token / 密码" : "WebUI 登录 token"}
                            {value === "snowluma" ? (
                              <Input className="font-mono" type="password" autoComplete="new-password" disabled={busy !== null}
                                value={snowLumaPassword} onChange={(event) => setSnowLumaPassword(event.target.value)}
                                placeholder="输入新的 WebUI 密码" />
                            ) : <Input readOnly className="font-mono" value={loginInfo[value].webuiToken ?? ""} placeholder="未获取到登录 token" />}
                          </label>
                          {value === "snowluma" ? (
                            <div className="grid gap-2">
                              <p className="text-xs text-muted-foreground">密码至少 10 位，包含大小写字母和特殊符号，不含空白。保存前请先停止 SnowLuma；保存后同时更新密码和自动登录凭据。</p>
                              {snowLumaPasswordDirty ? <Button disabled={busy !== null || snowLumaRunning || !snowLumaPassword} onClick={() => void saveSnowLumaPassword()} size="sm">
                                {busy === "snowluma:password" ? <Loader2 className="animate-spin" /> : <Save />}
                                保存密码
                              </Button> : null}
                              {snowLumaPasswordDirty && snowLumaRunning ? <p className="text-xs text-warning-foreground">请先停止 SnowLuma，再保存密码。</p> : null}
                            </div>
                          ) : null}
                          <label className="grid gap-1.5 text-xs text-muted-foreground">
                            已输入的 QQ 账号
                            <Input className="font-mono" value={qqAccounts[value]} inputMode="numeric" disabled={busy !== null}
                              onChange={(event) => setQqAccounts((current) => ({ ...current, [value]: event.target.value }))}
                              placeholder="输入机器人 QQ 号" />
                          </label>
                          {qqAccounts[value] !== (loginInfo[value].qqAccount ?? "") ? (
                            <div className="grid gap-2">
                              <Button size="sm" disabled={busy !== null || !normalizeQqAccount(qqAccounts[value]) || (value === snapshot.initState.qqBackend && qqBackendRunning)}
                                onClick={() => void saveQqAccount(value)}>
                                {busy === `${value}:account` ? <Loader2 className="animate-spin" /> : <Save />}
                                保存 QQ 账号
                              </Button>
                              {value === snapshot.initState.qqBackend && qqBackendRunning ? <p className="text-xs text-warning-foreground">请先停止当前 QQ 协议端，再保存账号。</p> : null}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </TabsContent>
              <TabsContent value="connections" className="space-y-3">
                <div className="settings-section grid gap-3 bg-muted/40 p-3">
                  <p className="text-sm font-medium">同步 QQ 连接配置</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    将当前协议端的连接信息保存到 MaiBot 适配器。需先启动 MaiBot；协议端配置保持不变。
                  </p>
                  {snapshot.initState.qqProtocol === "official" ? (
                    <p className="text-xs text-muted-foreground">官方 QQ 适配器不使用 OneBot 连接，无需同步。</p>
                  ) : null}
                  <Button
                    disabled={busy !== null || snapshot.initState.qqProtocol === "official"}
                    onClick={() => void syncConnections()}
                    size="sm"
                    variant="secondary"
                  >
                    {busy === "qq-connections:sync" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                    同步连接配置
                  </Button>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    适配器的启用状态由 MaiBot 管理，与协议端的启动、停止分别操作。
                  </p>
                  <div className="flex gap-2">
                    <Button disabled={busy !== null} onClick={() => void setAdapterEnabled(true)} size="sm" variant="secondary">启用适配器</Button>
                    <Button disabled={busy !== null} onClick={() => void setAdapterEnabled(false)} size="sm" variant="secondary">停用适配器</Button>
                  </div>
                </div>
              </TabsContent>
              <TabsContent value="reinstall" className="space-y-3">
                {qqComponentsChangeBlocked ? <p className="text-xs text-warning-foreground">QQ 协议端仍在运行，请先停止协议端。</p> : null}
                <div className="settings-section flex flex-wrap items-center justify-between gap-3 bg-muted/40 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">重新安装 NapCat / SnowLuma</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      使用当前一键包内置组件覆盖程序文件，保留配置、数据和日志。
                    </p>
                  </div>
                  <Button
                    disabled={busy !== null || qqComponentsChangeBlocked}
                    onClick={() => {
                      setError(null);
                      setConfirmQqComponentsUpgradeOpen(true);
                    }}
                    variant="secondary"
                  >
                    {busy === "qq-components:upgrade" ? <Loader2 className="animate-spin" /> : <Download />}
                    重新安装
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </DialogBody>
          <DialogFooter>
            <Button disabled={busy !== null} onClick={() => setOpen(false)} size="sm" variant="ghost">关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    <Dialog
      open={confirmQqComponentsUpgradeOpen}
      onOpenChange={(next) => {
        if (!next && busy !== "qq-components:upgrade") setConfirmQqComponentsUpgradeOpen(false);
      }}
    >
      <DialogContent size="md">
      <DialogHeader
        description="这会用一键包内置的 NapCat 与 SnowLuma 程序文件覆盖现有组件。"
        icon={<Download className="size-4" />}
        title="确认重新安装？"
        tone="warning"
      />
      <DialogBody className="space-y-3 text-sm">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
          配置、数据和日志会被保留；执行前请确认 MaiBot Core 与 QQ 后端都已停止。
        </div>
        {qqComponentsChangeBlocked ? (
          <div className="rounded-md border border-warning/30 bg-warning/15 px-3 py-2 text-xs text-warning-foreground">
            MaiBot Core 或 QQ 后端仍在运行，请先停止全部服务。
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button disabled={busy === "qq-components:upgrade"} onClick={() => setConfirmQqComponentsUpgradeOpen(false)} size="sm" variant="ghost">
          取消
        </Button>
        <Button
          disabled={busy === "qq-components:upgrade" || qqComponentsChangeBlocked}
          onClick={upgradeQqComponents}
          size="sm"
          variant="secondary"
        >
          {busy === "qq-components:upgrade" ? <Loader2 className="animate-spin" /> : <Download />}
          重新安装
        </Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
