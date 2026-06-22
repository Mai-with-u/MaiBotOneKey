import {
  CheckCircle2,
  DatabaseBackup,
  Download,
  FileCog,
  FolderInput,
  FolderOpen,
  Loader2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type {
  MaiBotBackupExportResult,
  MaiBotBackupImportResult,
  MaiBotBackupProgress,
  MaiBotConfigFileName,
  MaiBotConfigImportResult,
  MaiBotDataImportResult,
  RuntimeResourcePathChangeResult,
} from "../../../../shared/contracts";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

const backupProgressPhaseLabels: Record<MaiBotBackupProgress["phase"], string> = {
  scanning: "扫描中",
  packing: "打包中",
  writing: "写入中",
  extracting: "解包中",
  validating: "校验中",
  "backing-up": "备份中",
  restoring: "恢复中",
  rollback: "回退中",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
};

function isCancelError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("操作已取消"));
}

function BackupProgressDetails({ progress }: { progress: MaiBotBackupProgress }): React.JSX.Element {
  const byteText =
    progress.processedBytes !== undefined && progress.totalBytes !== undefined
      ? `${formatBytes(progress.processedBytes)} / ${formatBytes(progress.totalBytes)}`
      : null;
  const fileText =
    progress.processedFiles !== undefined && progress.totalFiles !== undefined
      ? `${progress.processedFiles} / ${progress.totalFiles} 个文件`
      : null;
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 text-[12px]">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="font-medium">
          {progress.operation === "export" ? "导出" : "导入"} · {backupProgressPhaseLabels[progress.phase]}
        </span>
        <span className="font-mono tabular-nums">{Math.round(progress.percent)}%</span>
      </div>
      <Progress
        className={progress.phase === "failed" ? "[&_[data-slot=progress-indicator]]:bg-destructive" : undefined}
        value={progress.percent}
      />
      <div className="mt-2 grid gap-0.5 text-muted-foreground">
        {progress.detail ? <div>{progress.detail}</div> : null}
        {progress.currentPath ? <div className="break-all">当前：{progress.currentPath}</div> : null}
        {byteText || fileText ? (
          <div>
            {byteText}
            {byteText && fileText ? " · " : ""}
            {fileText}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ResultDetails({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-primary/30 bg-primary/10 p-3 text-[12px] text-foreground">
      <div className="flex items-center gap-1.5 font-medium text-primary">
        <CheckCircle2 className="size-3.5" />
        {title}
      </div>
      <dl className="mt-1.5 grid gap-0.5 text-muted-foreground">{children}</dl>
    </div>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0">{label}</dt>
      <dd className="break-all">{children}</dd>
    </div>
  );
}

export function QuickActionsPanel({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const [importing, setImporting] = useState(false);
  const [backupBusy, setBackupBusy] = useState<"export" | "import" | null>(null);
  const [selectingMaiBotPath, setSelectingMaiBotPath] = useState(false);
  const [backupProgress, setBackupProgress] = useState<MaiBotBackupProgress | null>(null);
  const [lastBackupExport, setLastBackupExport] = useState<MaiBotBackupExportResult | null>(null);
  const [lastBackupImport, setLastBackupImport] = useState<MaiBotBackupImportResult | null>(null);
  const [lastImport, setLastImport] = useState<MaiBotDataImportResult | null>(null);
  const [lastMaiBotPathChange, setLastMaiBotPathChange] =
    useState<RuntimeResourcePathChangeResult | null>(null);
  const [importingConfig, setImportingConfig] = useState<MaiBotConfigFileName | null>(null);
  const [lastConfigImports, setLastConfigImports] = useState<
    Partial<Record<MaiBotConfigFileName, MaiBotConfigImportResult>>
  >({});

  useEffect(() => {
    return window.maibotDesktop?.data?.onMaiBotBackupProgress((progress) => {
      setBackupProgress(progress);
    });
  }, []);

  const handleSelectMaiBotPath = async (): Promise<void> => {
    if (!window.maibotDesktop?.resources) {
      toast.error("当前环境不支持该操作");
      return;
    }
    setSelectingMaiBotPath(true);
    try {
      const result = await window.maibotDesktop.resources.selectPath("maibot");
      if (!result) {
        toast.info("已取消选择");
        return;
      }
      setLastMaiBotPathChange(result);
      toast.success("MaiBot 路径已切换", { description: result.path });
    } catch (error) {
      toast.error("切换 MaiBot 路径失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSelectingMaiBotPath(false);
    }
  };

  const handleExportBackup = async (): Promise<void> => {
    if (!window.maibotDesktop?.data) {
      toast.error("当前环境不支持该操作");
      return;
    }
    setBackupBusy("export");
    setBackupProgress(null);
    try {
      const result = await window.maibotDesktop.data.exportMaiBotBackup();
      if (!result) {
        toast.info("已取消导出");
        setBackupProgress(null);
        return;
      }
      setLastBackupExport(result);
      toast.success("MaiBot 迁移包导出完成", { description: result.filePath });
    } catch (error) {
      const cancelled = isCancelError(error);
      setBackupProgress({
        operation: "export",
        phase: cancelled ? "cancelled" : "failed",
        percent: 100,
        detail: cancelled ? "已取消导出，未完成的迁移包已清理" : error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });
      if (cancelled) {
        toast.info("已取消导出");
      } else {
        toast.error("导出迁移包失败", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setBackupBusy(null);
    }
  };

  const handleImportBackup = async (): Promise<void> => {
    if (!window.maibotDesktop?.data) {
      toast.error("当前环境不支持该操作");
      return;
    }
    setBackupBusy("import");
    setBackupProgress(null);
    try {
      const result = await window.maibotDesktop.data.importMaiBotBackup();
      if (!result) {
        toast.info("已取消导入");
        setBackupProgress(null);
        return;
      }
      setLastBackupImport(result);
      toast.success("MaiBot 迁移包导入完成", {
        description: result.restoredDataDir ?? result.restoredConfigDir,
      });
    } catch (error) {
      const cancelled = isCancelError(error);
      setBackupProgress({
        operation: "import",
        phase: cancelled ? "cancelled" : "failed",
        percent: 100,
        detail: cancelled ? "已取消导入，必要时已回退原 data/config 目录" : error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });
      if (cancelled) {
        toast.info("已取消导入");
      } else {
        toast.error("导入迁移包失败", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setBackupBusy(null);
    }
  };

  const handleCancelBackupOperation = async (): Promise<void> => {
    if (!window.maibotDesktop?.data || backupBusy === null) {
      return;
    }
    try {
      const cancelled = await window.maibotDesktop.data.cancelMaiBotBackupOperation();
      if (!cancelled) {
        toast.info("当前没有正在运行的迁移任务");
      }
    } catch (error) {
      toast.error("取消迁移任务失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

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
      toast.success("MaiBot.db 导入完成", { description: `已写入 ${result.destPath}` });
    } catch (error) {
      toast.error("导入失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setImporting(false);
    }
  };

  const handleImportConfig = async (fileName: MaiBotConfigFileName): Promise<void> => {
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
      toast.success(`${fileName} 导入完成`, { description: `已写入 ${result.destPath}` });
    } catch (error) {
      toast.error(`${fileName} 导入失败`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setImportingConfig(null);
    }
  };

  return (
    <div className={embedded ? "max-h-[70vh] overflow-y-auto" : "h-full overflow-y-auto bg-background"}>
      <div className={embedded ? "flex flex-col gap-4 pr-2" : "mx-auto flex max-w-3xl flex-col gap-4 p-6"}>
        <div className={embedded ? "hidden" : undefined}>
          <h2 className="text-base font-semibold">快捷操作</h2>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <span className="retro-control grid size-9 shrink-0 place-items-center text-primary">
                <FolderOpen className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <CardTitle>设置 MaiBot 路径</CardTitle>
                <CardDescription>
                  选择已有 MaiBot Core 目录作为当前实例路径。切换前请先停止所有服务，避免运行中的文件被占用。
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={selectingMaiBotPath} onClick={handleSelectMaiBotPath} size="sm">
                {selectingMaiBotPath ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                选择 MaiBot 目录
              </Button>
              <span className="text-[11px] text-muted-foreground">
                仅切换路径，不复制现有 MaiBot 数据
              </span>
            </div>
            {lastMaiBotPathChange ? (
              <ResultDetails title="最近一次路径切换">
                <DetailRow label="原路径：">{lastMaiBotPathChange.previousPath}</DetailRow>
                <DetailRow label="新路径：">{lastMaiBotPathChange.path}</DetailRow>
                <DetailRow label="时间：">{formatTime(lastMaiBotPathChange.changedAt)}</DetailRow>
              </ResultDetails>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <span className="retro-control grid size-9 shrink-0 place-items-center text-primary">
                <DatabaseBackup className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <CardTitle>MaiBot 数据迁移包</CardTitle>
                <CardDescription>
                  导出 <code className="rounded bg-muted px-1 py-0.5 text-[11px]">MaiBot/data</code>
                  与 <code className="rounded bg-muted px-1 py-0.5 text-[11px]">MaiBot/config</code>
                  的迁移包，并写入 manifest 元信息。MaiBot/plugins 暂不打包，导入前会自动备份现有目录。
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={backupBusy !== null} onClick={handleExportBackup} size="sm">
                {backupBusy === "export" ? <Loader2 className="animate-spin" /> : <Download />}
                导出迁移包
              </Button>
              <Button
                disabled={backupBusy !== null}
                onClick={handleImportBackup}
                size="sm"
                variant="secondary"
              >
                {backupBusy === "import" ? <Loader2 className="animate-spin" /> : <Upload />}
                导入迁移包
              </Button>
              {backupBusy !== null ? (
                <Button onClick={handleCancelBackupOperation} size="sm" variant="outline">
                  <X />
                  取消
                </Button>
              ) : null}
              <span className="text-[11px] text-muted-foreground">
                导入或导出前请先停止 MaiBot Core
              </span>
            </div>
            {backupProgress ? <BackupProgressDetails progress={backupProgress} /> : null}
            {lastBackupExport ? (
              <ResultDetails title="最近一次导出">
                <DetailRow label="文件：">{lastBackupExport.filePath}</DetailRow>
                <DetailRow label="大小：">{formatBytes(lastBackupExport.sizeBytes)}</DetailRow>
                <DetailRow label="数据：">{formatBytes(lastBackupExport.manifest.paths.data.sizeBytes)}</DetailRow>
                <DetailRow label="配置：">{formatBytes(lastBackupExport.manifest.paths.config.sizeBytes)}</DetailRow>
                <DetailRow label="时间：">{formatTime(lastBackupExport.exportedAt)}</DetailRow>
              </ResultDetails>
            ) : null}
            {lastBackupImport ? (
              <ResultDetails title="最近一次迁移包导入">
                <DetailRow label="来源：">{lastBackupImport.sourcePath}</DetailRow>
                {lastBackupImport.restoredDataDir ? (
                  <DetailRow label="数据目录：">{lastBackupImport.restoredDataDir}</DetailRow>
                ) : null}
                {lastBackupImport.restoredConfigDir ? (
                  <DetailRow label="配置目录：">{lastBackupImport.restoredConfigDir}</DetailRow>
                ) : null}
                {lastBackupImport.backupDataDir ? (
                  <DetailRow label="原数据备份：">{lastBackupImport.backupDataDir}</DetailRow>
                ) : null}
                {lastBackupImport.backupConfigDir ? (
                  <DetailRow label="原配置备份：">{lastBackupImport.backupConfigDir}</DetailRow>
                ) : null}
                <DetailRow label="包版本：">{lastBackupImport.manifest.formatVersion}</DetailRow>
                <DetailRow label="时间：">{formatTime(lastBackupImport.importedAt)}</DetailRow>
              </ResultDetails>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <span className="retro-control grid size-9 shrink-0 place-items-center text-primary">
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
              <Button disabled={importing} onClick={handleImport} size="sm">
                {importing ? <Loader2 className="animate-spin" /> : <FolderInput />}
                选择 MaiBot.db 并导入
              </Button>
              <span className="text-[11px] text-muted-foreground">
                建议导入前先停止 MaiBot Core 服务
              </span>
            </div>
            {lastImport ? (
              <ResultDetails title="最近一次导入">
                <DetailRow label="来源：">{lastImport.sourcePath}</DetailRow>
                <DetailRow label="目标：">{lastImport.destPath}</DetailRow>
                <DetailRow label="大小：">{formatBytes(lastImport.sizeBytes)}</DetailRow>
                {lastImport.backupPath ? (
                  <DetailRow label="原文件备份：">{lastImport.backupPath}</DetailRow>
                ) : null}
                <DetailRow label="时间：">{formatTime(lastImport.importedAt)}</DetailRow>
              </ResultDetails>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <span className="retro-control grid size-9 shrink-0 place-items-center text-primary">
                <FileCog className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <CardTitle>导入 MaiBot 配置文件</CardTitle>
                <CardDescription>
                  覆盖 <code className="rounded bg-muted px-1 py-0.5 text-[11px]">MaiBot/config</code>
                  目录下的 <code className="rounded bg-muted px-1 py-0.5 text-[11px]">bot_config.toml</code>
                  或 <code className="rounded bg-muted px-1 py-0.5 text-[11px]">model_config.toml</code>。
                  覆盖前会对原文件做时间戳备份。
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={importingConfig !== null}
                onClick={() => void handleImportConfig("bot_config.toml")}
                size="sm"
              >
                {importingConfig === "bot_config.toml" ? <Loader2 className="animate-spin" /> : <FolderInput />}
                导入 bot_config.toml
              </Button>
              <Button
                disabled={importingConfig !== null}
                onClick={() => void handleImportConfig("model_config.toml")}
                size="sm"
                variant="secondary"
              >
                {importingConfig === "model_config.toml" ? <Loader2 className="animate-spin" /> : <FolderInput />}
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
                <ResultDetails key={name} title={`${name} 最近一次导入`}>
                  <DetailRow label="来源：">{last.sourcePath}</DetailRow>
                  <DetailRow label="目标：">{last.destPath}</DetailRow>
                  <DetailRow label="大小：">{formatBytes(last.sizeBytes)}</DetailRow>
                  {last.backupPath ? (
                    <DetailRow label="原文件备份：">{last.backupPath}</DetailRow>
                  ) : null}
                  <DetailRow label="时间：">{formatTime(last.importedAt)}</DetailRow>
                </ResultDetails>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
