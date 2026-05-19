import {
  CheckCircle2,
  DatabaseBackup,
  FileCog,
  FolderInput,
  FolderOpen,
  Loader2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
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

function ResultDetails({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-success/40 bg-success/10 p-3 text-[12px] text-foreground">
      <div className="flex items-center gap-1.5 font-medium text-success">
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
  const [selectingMaiBotPath, setSelectingMaiBotPath] = useState(false);
  const [lastImport, setLastImport] = useState<MaiBotDataImportResult | null>(null);
  const [lastMaiBotPathChange, setLastMaiBotPathChange] =
    useState<RuntimeResourcePathChangeResult | null>(null);
  const [importingConfig, setImportingConfig] = useState<MaiBotConfigFileName | null>(null);
  const [lastConfigImports, setLastConfigImports] = useState<
    Partial<Record<MaiBotConfigFileName, MaiBotConfigImportResult>>
  >({});

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
          <h2 className="text-base font-semibold tracking-tight">快捷操作</h2>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
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
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
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
