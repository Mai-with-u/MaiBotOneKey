import { useEffect, useState } from "react";
import { ArrowRightLeft, Bot, CheckCircle2, FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { InstanceCreateRequest, LauncherInstanceState } from "@shared/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SettingsSection } from "@/components/ui/surface";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";

const labels = { maibot: "MaiBot" };
export function InstanceManagerPanel({ blocked }: { blocked: boolean }) {
  const [state, setState] = useState<LauncherInstanceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<InstanceCreateRequest | null>(null);
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const api = window.maibotDesktop?.resources;
  useEffect(() => { if (api) void api.listInstances().then(setState).catch(error => toast.error(String(error))); }, [api, blocked]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); } catch (error) { toast.error(String(error)); } finally { setBusy(false); }
  };
  if (!api || !state) return <p className="text-xs text-muted-foreground">实例列表尚未加载，请确认已连接桌面主进程。</p>;
  const disabled = blocked || busy;
  return <SettingsSection className="grid gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2"><Bot className="size-5 text-primary" /><p className="text-base font-semibold">MaiBot 实例</p><Badge variant="outline">单实例运行</Badge></div>
      <div className="flex gap-2">{(["new", "existing"] as const).map(mode => <Button key={mode} size="sm" variant="outline" disabled={disabled} onClick={() => setDraft({ name: "", mode, paths: { maibot: "" } })}>{mode === "new" ? <Plus /> : <FolderOpen />}{mode === "new" ? "新建" : "接入"}</Button>)}</div>
    </div>
    {state.instances.map(item => <div key={item.id} className={`rounded-md border p-3 ${item.id === state.activeId ? "border-primary/60 bg-primary/10" : "border-border"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex min-w-0 flex-wrap items-center gap-2">{item.id === state.activeId ? <CheckCircle2 className="size-4 shrink-0 text-primary" /> : <Bot className="size-4 shrink-0 text-muted-foreground" />}<span className="break-all text-sm font-medium">{item.name}</span>{item.id === state.activeId && <Badge variant="secondary">当前实例</Badge>}{item.development && <Badge variant="secondary">{item.development.mode === "source" ? "源码调试" : "PyPI 开发"}</Badge>}{item.legacy && <Badge variant="secondary">旧版接入</Badge>}</div>
        <div className="flex gap-2"><Button size="icon" variant="ghost" aria-label={`重命名 ${item.name}`} title="重命名" disabled={disabled} onClick={() => setEdit({ id: item.id, name: item.name })}><Pencil className="size-4" /></Button><Button size="icon" variant="ghost" aria-label={`切换到 ${item.name}`} title="切换实例" disabled={disabled || item.id === state.activeId} onClick={() => void run(async () => { await api.selectInstance(item.id); })}><ArrowRightLeft className="size-4" /></Button><Button size="icon" variant="ghost" aria-label={`移除 ${item.name}`} title="移除登记，保留文件" disabled={disabled || item.id === state.activeId || Boolean(item.development)} onClick={() => setRemoveId(item.id)}><Trash2 className="size-4" /></Button></div>
      </div>
      <dl className="mt-2 grid gap-1 text-xs text-muted-foreground">{(Object.keys(labels) as (keyof typeof labels)[]).map(key => <div key={key} className="break-all"><dt className="sr-only">{labels[key]} 目录</dt><dd className="inline">{item.paths[key]}</dd></div>)}</dl>
    </div>)}
    {blocked && <p className="text-xs text-muted-foreground">请先停止所有服务并等待当前操作完成，再管理实例。</p>}
    <Dialog open={Boolean(draft)} onOpenChange={open => { if (!open && !busy) setDraft(null); }}><DialogContent><DialogHeader title={draft?.mode === "new" ? "新建实例" : "接入已有实例"} /><DialogBody className="grid gap-3">
      <p className="text-xs text-muted-foreground">{draft?.mode === "new" ? "选择 MaiBot 的空目录，切换后完成初始化。协议端沿用启动器的公共配置。" : "选择已有 MaiBot 目录，原文件不会移动。NapCat 和账号配置由启动器共用，接入后请检查 MaiBot 的适配器连接。"}</p>
      <label className="grid gap-1 text-sm">实例名称<Input value={draft?.name ?? ""} maxLength={80} disabled={busy} onChange={event => setDraft(value => value && { ...value, name: event.target.value })} /></label>
      {(Object.keys(labels) as (keyof typeof labels)[]).map(key => <label key={key} className="grid gap-1 text-sm">{labels[key]} 目录<div className="flex gap-2"><Input value={draft?.paths[key] ?? ""} disabled={busy} placeholder="MaiBot 的完整目录路径" onChange={event => setDraft(value => value && { ...value, paths: { ...value.paths, [key]: event.target.value } })} /><Button variant="outline" disabled={busy} onClick={() => void run(async () => { const path = await api.choosePath(key, draft?.mode === "new" ? "copy" : "existing"); if (path) setDraft(value => value && { ...value, paths: { ...value.paths, [key]: path } }); })}>浏览</Button></div></label>)}
    </DialogBody><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDraft(null)}>取消</Button><Button disabled={disabled || !draft?.name.trim() || !draft?.paths.maibot.trim()} onClick={() => void run(async () => { if (draft) { setState(await api.createInstance(draft)); setDraft(null); toast.success("实例已登记，可在列表中切换"); } })}>保存实例</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(edit)} onOpenChange={open => { if (!open && !busy) setEdit(null); }}><DialogContent><DialogHeader title="重命名实例" /><DialogBody><Input aria-label="实例名称" value={edit?.name ?? ""} maxLength={80} onChange={event => setEdit(value => value && { ...value, name: event.target.value })} /></DialogBody><DialogFooter><Button disabled={disabled || !edit?.name.trim()} onClick={() => void run(async () => { if (edit) { setState(await api.renameInstance(edit.id, edit.name)); setEdit(null); } })}>保存</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(removeId)} onOpenChange={open => { if (!open && !busy) setRemoveId(null); }}><DialogContent><DialogHeader title="从列表移除实例" /><DialogBody>只移除实例登记，组件文件、配置和聊天数据全部保留。</DialogBody><DialogFooter><Button variant="outline" onClick={() => setRemoveId(null)}>取消</Button><Button disabled={disabled} onClick={() => void run(async () => { if (removeId) { setState(await api.removeInstance(removeId)); setRemoveId(null); } })}>移除登记</Button></DialogFooter></DialogContent></Dialog>
  </SettingsSection>;
}
