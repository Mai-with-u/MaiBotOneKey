import { useEffect, useState } from "react";
import { ArrowRight, Bot, CheckCircle2, ChevronDown, Copy, FolderOpen, Loader2, Network } from "lucide-react";
import type { ResourcePathMode, RuntimeResourcePathConfig, RuntimeResourcePathKey } from "@shared/contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
  const name = config.key === "maibot" ? "MaiBot" : config.key === "napcat" ? "NapCat" : "SnowLuma";
  const Icon = config.key === "maibot" ? Bot : Network;
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2"><span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary"><Icon className="size-4" /></span><span className="text-base font-semibold">{name}</span><Badge variant={config.customized ? "warning" : "secondary"}>{config.customized ? "自定义" : "默认"}</Badge></div>
        <Button aria-label={`打开 ${config.label} 当前目录`} onClick={() => onOpenPath(config.value)} size="icon" variant="ghost"><FolderOpen /></Button>
      </div>
      <p className="break-all rounded-md bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground" title={config.value}>{config.value}</p>
      <details className="group/path min-w-0">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-2 text-xs font-medium [&::-webkit-details-marker]:hidden"><FolderOpen className="size-4" />更改目录<ChevronDown className="ml-auto size-4 transition-transform group-open/path:rotate-180" /></summary>
        <div className="grid min-w-0 gap-3 pt-2">
          <SegmentedControl
            aria-label={`${config.label} 操作方式`}
            value={mode}
            onValueChange={setMode}
            disabled={busy || blocked}
            options={[{ value: "existing", label: "使用已有目录" }, { value: "copy", label: "复制迁移" }]}
          />
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {mode === "copy" ? <Copy className="size-4" /> : <FolderOpen className="size-4" />}
            <span>{mode === "copy" ? "当前目录" : "已有目录"}</span><ArrowRight className="size-4" />
            <span>{mode === "copy" ? "复制到空目录" : "设为当前"}</span>
            <Badge variant="outline">{mode === "copy" ? "保留原文件" : "不复制文件"}</Badge>
          </div>
          <label className="grid min-w-0 grid-cols-1 gap-1 text-xs">目标目录<Input monospace value={target} disabled={busy || blocked} onChange={(event) => setTarget(event.target.value)} placeholder="选择或输入完整路径" aria-label={`${config.label} 目标目录`} /></label>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy || blocked} onClick={() => setTarget(config.defaultValue)}>默认路径</Button>
            <Button size="sm" variant="outline" disabled={busy || blocked} onClick={() => void onBrowse(config.key, mode).then((path) => { if (path) setTarget(path); })}><FolderOpen />浏览</Button>
            <Button size="sm" disabled={busy || blocked || !target.trim()} onClick={() => void onPrepare(config.key, mode, target.trim())}>{busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}检查并{mode === "copy" ? "复制迁移" : "使用目录"}</Button>
          </div>
        </div>
      </details>
    </div>
  );
}
