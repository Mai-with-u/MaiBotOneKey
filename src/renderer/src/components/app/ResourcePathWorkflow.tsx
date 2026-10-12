import { isResourcePathCancellation } from "@shared/resource-path-operation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { ResourcePathMode, ResourcePathPlan, ResourcePathProgress, RuntimeResourcePathChangeResult, RuntimeResourcePathKey } from "@shared/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";

export const RESOURCE_SCOPE_NOTE = "仅操作所选组件目录。启动器保存的 QQ 账号、启动命令、下载源、代理、外观设置、共享 Python 环境和启动器日志不会迁移，也不会自动切换到目标实例的设置。自定义启动命令可能仍指向原目录；组件配置中的绝对路径不会自动改写，请在切换后检查。";
function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
const stageLabels: Record<ResourcePathProgress["stage"], string> = {
  checking: "正在检查目录和磁盘空间", copying: "正在复制并校验", committing: "正在保存并切换目录", "rolling-back": "正在回滚，请稍候", completed: "操作完成", cancelled: "已取消", failed: "操作未完成",
};

export function useResourcePathWorkflow(onComplete?: (result: RuntimeResourcePathChangeResult) => Promise<void>) {
  const [busyKey, setBusyKey] = useState<RuntimeResourcePathKey | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [plan, setPlan] = useState<ResourcePathPlan | null>(null);
  const [progress, setProgress] = useState<ResourcePathProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restoredOperation = useRef<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    const bridge = window.maibotDesktop?.resources;
    if (!bridge) return;
    let mounted = true;
    const off = bridge.onProgress((next) => {
      setProgress(next);
      if (["completed", "cancelled", "failed"].includes(next.stage) && restoredOperation.current === next.operationId) {
        setBusyKey(null); restoredOperation.current = null;
        if (next.stage === "failed") setError(next.error ?? "目录操作未完成，请检查当前路径。");
        if (next.stage === "cancelled") toast.info("目录操作已取消，原目录保持不变");
      }
    });
    void bridge.getProgress().then((next) => {
      if (mounted && next && ["checking", "copying", "committing", "rolling-back"].includes(next.stage)) {
        setProgress(next); setBusyKey(next.key); restoredOperation.current = next.operationId;
      }
    }).catch((nextError) => { if (mounted) setError(`无法读取目录操作进度：${String(nextError)}`); });
    return () => { mounted = false; off(); };
  }, []);

  const browse = useCallback(async (key: RuntimeResourcePathKey, mode: ResourcePathMode): Promise<string | null> => {
    setChoosing(true); setBusyKey(key); setError(null); setProgress(null);
    try {
      if (!window.maibotDesktop) throw new Error("无法连接启动器");
      return await window.maibotDesktop.resources.choosePath(key, mode);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); return null; }
    finally { setBusyKey(null); setChoosing(false); }
  }, []);
  const prepare = useCallback(async (key: RuntimeResourcePathKey, mode: ResourcePathMode, path?: string) => {
    const target = path ?? await browse(key, mode);
    if (!target) return;
    setBusyKey(key); setError(null); setPlan(null); setProgress(null);
    try {
      if (!window.maibotDesktop) throw new Error("无法连接启动器");
      setPlan(await window.maibotDesktop.resources.inspectPath(key, target, mode));
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      if (isResourcePathCancellation(nextError)) toast.info(message); else setError(message);
    } finally { setBusyKey(null); setCancelling(false); }
  }, [browse]);
  const apply = async () => {
    if (!plan || !window.maibotDesktop) return;
    setBusyKey(plan.key); setProgress(null); setError(null);
    try {
      const result = await window.maibotDesktop.resources.applyPath(plan);
      setPlan(null);
      toast.success(plan.mode === "copy" ? `已复制 ${result.copiedFiles} 个文件并切换目录；原目录已保留` : "已切换到所选目录，未复制数据");
      try { await onComplete?.(result); }
      catch (refreshError) { toast.error(`目录已切换，但界面刷新失败：${String(refreshError)}`); }
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      setPlan(null);
      if (isResourcePathCancellation(nextError)) toast.info(message); else setError(message);
    } finally { setBusyKey(null); setCancelling(false); }
  };
  const cancel = async () => {
    if (!progress || !window.maibotDesktop) return;
    setCancelling(true);
    try { if (!await window.maibotDesktop.resources.cancelOperation(progress.operationId)) setCancelling(false); }
    catch (nextError) { setCancelling(false); toast.error(String(nextError)); }
  };
  const canCancel = busyKey !== null && progress !== null && ["checking", "copying"].includes(progress.stage);
  const percent = progress ? Math.min(100, progress.totalBytes ? progress.copiedBytes / progress.totalBytes * 100 : progress.totalFiles ? progress.copiedFiles / progress.totalFiles * 100 : 0) : 0;
  const dialogs = (
    <Dialog open={(busyKey !== null && !choosing) || plan !== null || error !== null} onOpenChange={(open) => {
      if (!open && busyKey === null) { setPlan(null); setError(null); }
    }}>
      <DialogContent size="lg" showCloseButton={busyKey === null}>
        <DialogHeader title={busyKey ? "组件目录操作" : error ? "目录操作未完成" : plan?.mode === "copy" ? "确认复制迁移" : "确认使用已有目录"} />
        <DialogBody className="space-y-4 text-sm">
          {plan ? (
            <div className="grid gap-2 rounded-md border p-3">
              <p className="break-all">当前目录：<span className="font-mono">{plan.sourcePath}</span></p>
              <p className="break-all">目标目录：<span className="font-mono">{plan.targetPath}</span></p>
              {plan.mode === "copy" ? <>
                <p>将复制 {plan.fileCount} 个文件，共 {bytes(plan.totalBytes)}；目标剩余空间 {bytes(plan.availableBytes ?? 0)}。</p>
                <p>复制成功后切换到目标目录，原目录完整保留，不会释放原目录占用的磁盘空间。</p>
              </> : <p>{plan.unchanged ? "目标就是当前目录，不会更改路径。" : "直接使用目标目录中的程序和数据，不复制、不合并当前目录。"}</p>}
            </div>
          ) : null}
          <p className="rounded-md bg-muted p-3 text-xs leading-relaxed text-muted-foreground">{RESOURCE_SCOPE_NOTE} 使用已有目录后，请检查消息平台中的 QQ 账号和登录信息。</p>
          {busyKey ? <div className="space-y-2" role="status" aria-live="polite">
            <p className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />{progress ? stageLabels[progress.stage] : "正在选择或检查目录…"}</p>
            {progress?.stage === "checking" ? <p className="text-xs">已检查 {progress.totalFiles} 个文件，{bytes(progress.totalBytes)}</p> : null}
            {progress && progress.stage !== "checking" ? <><Progress value={percent} /><p className="text-xs">{progress.copiedFiles} / {progress.totalFiles} 个文件 · {bytes(progress.copiedBytes)} / {bytes(progress.totalBytes)}</p></> : null}
            {progress?.currentFile ? <p className="truncate font-mono text-xs" title={progress.currentFile}>{progress.currentFile}</p> : null}
            {progress?.stage === "committing" ? <p className="text-xs">正在完成路径切换，此阶段暂不能取消。</p> : null}
          </div> : null}
          {error ? <p className="break-all text-destructive" role="alert">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          {busyKey ? <Button variant="outline" disabled={!canCancel || cancelling} onClick={() => void cancel()}>{cancelling ? "正在取消…" : "取消操作"}</Button> : <Button variant="ghost" onClick={() => { setPlan(null); setError(null); }}>关闭</Button>}
          {plan && busyKey === null && !error ? <Button onClick={() => void apply()}>{plan.mode === "copy" ? "确认复制并切换" : "确认使用此目录"}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { busyKey, browse, prepare, dialogs };
}
