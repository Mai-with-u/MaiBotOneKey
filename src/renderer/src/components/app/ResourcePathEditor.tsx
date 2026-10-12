import { useEffect, useState } from "react";
import { CheckCircle2, FolderOpen, Loader2 } from "lucide-react";
import type { ResourcePathMode, RuntimeResourcePathConfig, RuntimeResourcePathKey } from "@shared/contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

export function ResourcePathEditor({ config, busy, blocked, onOpenPath, onBrowse, onPrepare }: {
  config: RuntimeResourcePathConfig;
  busy: boolean;
  blocked: boolean;
  onOpenPath: (path: string) => void;
  onBrowse: (key: RuntimeResourcePathKey, mode: ResourcePathMode) => Promise<string | null>;
  onPrepare: (key: RuntimeResourcePathKey, mode: ResourcePathMode, path: string) => Promise<void>;
}): React.JSX.Element {
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<ResourcePathMode>("existing");
  useEffect(() => { setTarget(""); }, [config.value]);
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2"><span className="text-sm font-medium">{config.label}</span><Badge variant={config.customized ? "warning" : "secondary"}>{config.customized ? "自定义" : "默认"}</Badge></div>
        <Button aria-label={`打开 ${config.label} 当前目录`} onClick={() => onOpenPath(config.value)} size="icon" variant="ghost"><FolderOpen /></Button>
      </div>
      <label className="grid gap-1 text-xs">当前使用目录<Input readOnly monospace value={config.value} aria-label={`${config.label} 当前目录`} /></label>
      <div className="flex flex-wrap gap-2" role="group" aria-label={`${config.label} 操作方式`}>
        {([{ value: "existing", label: "使用已有目录" }, { value: "copy", label: "复制迁移" }] as const).map((option) => <Button key={option.value} size="sm" variant={mode === option.value ? "secondary" : "ghost"} aria-pressed={mode === option.value} disabled={busy || blocked} onClick={() => setMode(option.value)}>{option.label}</Button>)}
      </div>
      <p className="text-xs text-muted-foreground">{mode === "copy" ? "复制当前组件的程序、配置和数据到空目录，成功后切换，原目录保留。" : "直接使用已安装的组件目录，不复制当前数据。"}</p>
      <label className="grid gap-1 text-xs">目标目录<Input monospace value={target} disabled={busy || blocked} onChange={(event) => setTarget(event.target.value)} placeholder="输入完整目录路径，或点击浏览目录" aria-label={`${config.label} 目标目录`} /></label>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy || blocked} onClick={() => setTarget(config.defaultValue)}>填入默认目录</Button>
        <Button size="sm" variant="outline" disabled={busy || blocked} onClick={() => void onBrowse(config.key, mode).then((path) => { if (path) setTarget(path); })}><FolderOpen />浏览目录</Button>
        <Button size="sm" disabled={busy || blocked || !target.trim()} onClick={() => void onPrepare(config.key, mode, target.trim())}>{busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}检查并{mode === "copy" ? "复制迁移" : "使用目录"}</Button>
      </div>
    </div>
  );
}
