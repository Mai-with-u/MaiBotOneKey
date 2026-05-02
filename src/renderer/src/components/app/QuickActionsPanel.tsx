import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  FileCog,
  FolderInput,
  Loader2,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import type {
  MaiBotConfigFileName,
  MaiBotConfigImportResult,
  MaiBotDataImportResult,
  MaiBotDataResetResult,
} from "../../../../shared/contracts";
import { NapcatAdapterConfigCard } from "./NapcatAdapterConfigCard";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function QuickActionsPanel(): React.JSX.Element {
  const [importing, setImporting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [lastImport, setLastImport] = useState<MaiBotDataImportResult | null>(
    null,
  );
  const [lastReset, setLastReset] = useState<MaiBotDataResetResult | null>(null);

  const [importingConfig, setImportingConfig] = useState<MaiBotConfigFileName | null>(
    null,
  );
  const [lastConfigImports, setLastConfigImports] = useState<
    Partial<Record<MaiBotConfigFileName, MaiBotConfigImportResult>>
  >({});

  const [confirm1Open, setConfirm1Open] = useState(false);
  const [confirm2Open, setConfirm2Open] = useState(false);

  const handleImport = async (): Promise<void> => {
    if (!window.maibotDesktop?.data) {
      toast.error("当前环境不支持该操作");
      return;
    }
    setImporting(true);
    try {
      const result = await window.maibotDesktop.data.importMaiBotDatabase();
      if (!result) {
        toast.info("已取消导入");
        return;
      }
      setLastImport(result);
      toast.success("MaiBot.db 导入完成", {
        description: `已写入 ${result.destPath}`,
      });
    } catch (error) {
      toast.error("导入失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setImporting(false);
    }
  };

  const handleResetRequest = (): void => {
    setConfirm1Open(true);
  };

  const handleImportConfig = async (
    fileName: MaiBotConfigFileName,
  ): Promise<void> => {
    if (!window.maibotDesktop?.data) {
      toast.error("当前环境不支持该操作");
      return;
    }
    setImportingConfig(fileName);
    try {
      const result = await window.maibotDesktop.data.importMaiBotConfig(fileName);
      if (!result) {
        toast.info("已取消导入");
        return;
      }
      setLastConfigImports((prev) => ({ ...prev, [fileName]: result }));
      toast.success(`${fileName} 导入完成`, {
        description: `已写入 ${result.destPath}`,
      });
    } catch (error) {
      toast.error(`${fileName} 导入失败`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setImportingConfig(null);
    }
  };

  const handleConfirm1 = (): void => {
    setConfirm1Open(false);
    setConfirm2Open(true);
  };

  const handleConfirm2 = async (): Promise<void> => {
    if (!window.maibotDesktop?.data) {
      toast.error("当前环境不支持该操作");
      setConfirm2Open(false);
      return;
    }
    setResetting(true);
    try {
      const result = await window.maibotDesktop.data.resetMaiBotData();
      setLastReset(result);
      toast.success(
        `已清空 MaiBot 数据（共 ${result.removedEntries.length} 项）`,
        { description: result.dataDir },
      );
      setConfirm2Open(false);
    } catch (error) {
      toast.error("重置失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
        <div>
          <h2 className="text-base font-semibold tracking-tight">快捷操作</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            常用的 MaiBot 数据维护操作。所有操作都会写入可写模块目录，请在执行前确认 MaiBot Core 已停止运行。
          </p>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                <DatabaseBackup className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <CardTitle>从旧版本导入数据库</CardTitle>
                <CardDescription>
                  选择旧版本一键包内的 <code className="rounded bg-muted px-1 py-0.5 text-[11px]">MaiBot.db</code>
                  ，覆盖到当前 MaiBot Core 的 data 目录。导入前会自动备份现有数据库。
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={handleImport} disabled={importing} size="sm">
                {importing ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <FolderInput />
                )}
                选择 MaiBot.db 并导入
              </Button>
              <span className="text-[11px] text-muted-foreground">
                建议导入前先停止 MaiBot Core 服务
              </span>
            </div>
            {lastImport ? (
              <div className="rounded-md border border-success/40 bg-success/10 p-3 text-[12px] text-foreground">
                <div className="flex items-center gap-1.5 font-medium text-success">
                  <CheckCircle2 className="size-3.5" />
                  最近一次导入
                </div>
                <dl className="mt-1.5 grid gap-0.5 text-muted-foreground">
                  <div className="flex gap-2">
                    <dt className="shrink-0">来源：</dt>
                    <dd className="break-all">{lastImport.sourcePath}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="shrink-0">目标：</dt>
                    <dd className="break-all">{lastImport.destPath}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="shrink-0">大小：</dt>
                    <dd>{formatBytes(lastImport.sizeBytes)}</dd>
                  </div>
                  {lastImport.backupPath ? (
                    <div className="flex gap-2">
                      <dt className="shrink-0">原文件备份：</dt>
                      <dd className="break-all">{lastImport.backupPath}</dd>
                    </div>
                  ) : null}
                  <div className="flex gap-2">
                    <dt className="shrink-0">时间：</dt>
                    <dd>{formatTime(lastImport.importedAt)}</dd>
                  </div>
                </dl>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                <FileCog className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <CardTitle>导入 MaiBot 配置文件</CardTitle>
                <CardDescription>
                  覆盖 <code className="rounded bg-muted px-1 py-0.5 text-[11px]">MaiBot/config</code>
                  目录下的 <code className="rounded bg-muted px-1 py-0.5 text-[11px]">bot_config.toml</code>
                  或 <code className="rounded bg-muted px-1 py-0.5 text-[11px]">model_config.toml</code>。
                  覆盖前会对原文件做时间戳备份（<code className="rounded bg-muted px-1 py-0.5 text-[11px]">*.bak.&lt;时间&gt;</code>）。
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => handleImportConfig("bot_config.toml")}
                disabled={importingConfig !== null}
                size="sm"
              >
                {importingConfig === "bot_config.toml" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <FolderInput />
                )}
                导入 bot_config.toml
              </Button>
              <Button
                onClick={() => handleImportConfig("model_config.toml")}
                disabled={importingConfig !== null}
                size="sm"
                variant="secondary"
              >
                {importingConfig === "model_config.toml" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <FolderInput />
                )}
                导入 model_config.toml
              </Button>
              <span className="text-[11px] text-muted-foreground">
                覆盖配置前请先停止 MaiBot Core
              </span>
            </div>
            {(["bot_config.toml", "model_config.toml"] as const).map((name) => {
              const last = lastConfigImports[name];
              if (!last) return null;
              return (
                <div
                  key={name}
                  className="rounded-md border border-success/40 bg-success/10 p-3 text-[12px] text-foreground"
                >
                  <div className="flex items-center gap-1.5 font-medium text-success">
                    <CheckCircle2 className="size-3.5" />
                    {name} · 最近一次导入
                  </div>
                  <dl className="mt-1.5 grid gap-0.5 text-muted-foreground">
                    <div className="flex gap-2">
                      <dt className="shrink-0">来源：</dt>
                      <dd className="break-all">{last.sourcePath}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="shrink-0">目标：</dt>
                      <dd className="break-all">{last.destPath}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="shrink-0">大小：</dt>
                      <dd>{formatBytes(last.sizeBytes)}</dd>
                    </div>
                    {last.backupPath ? (
                      <div className="flex gap-2">
                        <dt className="shrink-0">原文件备份：</dt>
                        <dd className="break-all">{last.backupPath}</dd>
                      </div>
                    ) : null}
                    <div className="flex gap-2">
                      <dt className="shrink-0">时间：</dt>
                      <dd>{formatTime(last.importedAt)}</dd>
                    </div>
                  </dl>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <NapcatAdapterConfigCard />

        <Card className="border-destructive/40">
          <CardHeader>
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-destructive/12 text-destructive">
                <Trash2 className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <CardTitle>重置 MaiBot 数据</CardTitle>
                <CardDescription>
                  清空 MaiBot Core 的 <code className="rounded bg-muted px-1 py-0.5 text-[11px]">data</code>
                  目录下所有内容，包括数据库、记忆、日志缓存等。该操作不可恢复，需要二次确认。
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={handleResetRequest}
                disabled={resetting}
                size="sm"
                variant="destructive"
              >
                {resetting ? <Loader2 className="animate-spin" /> : <Trash2 />}
                重置数据
              </Button>
              <span className="text-[11px] text-muted-foreground">
                请在确认无重要数据后再执行
              </span>
            </div>
            {lastReset ? (
              <div className="rounded-md border border-warning/40 bg-warning/15 p-3 text-[12px] text-foreground">
                <div className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="size-3.5" />
                  最近一次重置
                </div>
                <dl className="mt-1.5 grid gap-0.5 text-muted-foreground">
                  <div className="flex gap-2">
                    <dt className="shrink-0">目录：</dt>
                    <dd className="break-all">{lastReset.dataDir}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="shrink-0">移除项数：</dt>
                    <dd>{lastReset.removedEntries.length}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="shrink-0">时间：</dt>
                    <dd>{formatTime(lastReset.clearedAt)}</dd>
                  </div>
                </dl>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={confirm1Open}
        onOpenChange={(open) => {
          if (!resetting) setConfirm1Open(open);
        }}
      >
        <DialogContent size="sm">
          <DialogHeader
            tone="warning"
            icon={<AlertTriangle className="size-4" />}
            title="确认重置 MaiBot 数据？"
            description="此操作会清空 MaiBot Core 的 data 目录，包括数据库与记忆等运行时数据。"
          />
          <DialogBody>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              重置后无法恢复，建议先使用上方“导入数据库”功能或手动备份 data 目录。继续将进入二次确认。
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirm1Open(false)}>
              取消
            </Button>
            <Button variant="destructive" size="sm" onClick={handleConfirm1}>
              我已了解，下一步
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirm2Open}
        onOpenChange={(open) => {
          if (!resetting) setConfirm2Open(open);
        }}
      >
        <DialogContent size="sm">
          <DialogHeader
            tone="danger"
            icon={<Trash2 className="size-4" />}
            title="再次确认：彻底清空 data 目录"
            description="所有 MaiBot 运行时数据将被永久删除。此操作不可撤销。"
          />
          <DialogBody>
            <p className="text-[13px] leading-relaxed text-foreground">
              真的要继续吗？请确认 MaiBot Core 已停止，且不再需要这些数据。
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirm2Open(false)}
              disabled={resetting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleConfirm2}
              disabled={resetting}
            >
              {resetting ? <Loader2 className="animate-spin" /> : <Trash2 />}
              确认清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
