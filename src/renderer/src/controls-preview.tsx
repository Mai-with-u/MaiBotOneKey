// Development entry served at /controls.html by `bun run dev:web`.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { transitionStartupScene } from "@/lib/startup-transition";
import { Download, Radar, PackageCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ChoiceCard } from "@/components/ui/choice-card";
import { DataPanel, SettingsSection } from "@/components/ui/surface";
import { StatusLight } from "@/components/ui/status-light";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InitializationPage } from "@/components/app/InitializationPage";
import { MaiBotOverviewCard } from "@/components/app/MaiBotOverviewCard";
import { Titlebar } from "@/components/app/Titlebar";
import { StartupAgreementPage } from "@/components/app/StartupAgreementPage";
import { createPreviewSnapshot } from "@/lib/desktop-preview";
import { DependencyPreparationNotice } from "@/components/app/DependencyPreparationNotice";
import { MillenniumStatusPanel } from "@/components/app/MillenniumStatusPanel";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import "./styles/globals.css";
import "./styles/millennium.css";
import "./styles/ui-components.css";

function ControlsPreview(): React.JSX.Element {
  const [mode, setMode] = useState("millennium");
  const [dark, setDark] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [protocol, setProtocol] = useState("napcat");
  const [update, setUpdate] = useState("maibot");
  const [progress, setProgress] = useState(42);
  function theme(nextMode: string, nextDark: boolean): void {
    document.documentElement.dataset.appearanceMode = nextMode;
    document.documentElement.classList.toggle("dark", nextDark);
    setMode(nextMode);
    setDark(nextDark);
  }
  return (
    <main className="mx-auto grid max-w-3xl gap-5 p-6">
      <h1 className="text-xl font-semibold">一键包公共组件</h1>
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl aria-label="外观" value={mode} onValueChange={(next) => theme(next, dark)} options={[{ value: "modern", label: "现代" }, { value: "future-retro", label: "未来复古" }, { value: "millennium", label: "千禧" }]} />
        <label className="flex items-center gap-2 text-sm"><Switch checked={dark} onCheckedChange={(next) => theme(mode, next)} />深色</label>
      </div>
      <SettingsSection className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button><Download />安装更新</Button><Button variant="outline">恢复默认</Button><Button variant="ghost">取消</Button><Button disabled>处理中</Button>
          <Button size="icon" variant="outline" aria-label="下载"><Download /></Button>
        </div>
        <div className="flex flex-wrap items-center gap-3"><Input aria-label="代理端口" placeholder="7890" className="w-32" /><label className="flex items-center gap-2 text-sm"><Switch checked={enabled} onCheckedChange={setEnabled} />启用代理</label><Switch aria-label="不可用开关" disabled /></div>
        <SegmentedControl aria-label="协议端" value={protocol} onValueChange={setProtocol} options={[{ value: "napcat", label: "NapCat" }, { value: "snowluma", label: "SnowLuma" }, { value: "official", label: "官方 QQ", disabled: true }]} />
      </SettingsSection>
      <div className="grid grid-cols-2 gap-2">
        <ChoiceCard selected={update === "maibot"} onClick={() => setUpdate("maibot")} title="MaiBot 更新" icon={<Radar />} description="1.3.8 → 1.3.9" />
        <ChoiceCard selected={update === "launcher"} onClick={() => setUpdate("launcher")} title="启动器更新" icon={<PackageCheck />} description="v0.7.0 → v0.7.0" />
      </div>
      <Card variant="flat"><CardHeader><CardTitle>准备麦麦运行环境</CardTitle></CardHeader><CardContent className="grid gap-3">
        <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-2"><StatusLight status="mixed" decorative />安装依赖</span><span>{progress}%</span></div>
        <Progress aria-label="安装进度" variant="framed" value={progress} />
        <input aria-label="调整进度" type="range" value={progress} onChange={(event) => setProgress(Number(event.target.value))} />
        <DataPanel tone="terminal" className="h-28 overflow-auto font-mono text-xs">› startup dependency upgrade: checking MaiBot dependencies</DataPanel>
      </CardContent></Card>
      <DataPanel className="flex items-center gap-4 text-sm">运行状态{(["on", "off", "mixed", "error"] as const).map((status) => <StatusLight key={status} status={status} />)}</DataPanel>
    </main>
  );
}

function StartupPreview(): React.JSX.Element {
  const [source, setSource] = useState("tuna");
  const [logs, setLogs] = useState(() => Array.from({ length: 12 }, (_, index) => ({ id: String(index), message: `演示日志 ${index + 1}：正在准备 MaiBot 运行依赖…` })));
  const retro = document.documentElement.dataset.appearanceMode !== "modern";
  return <div className={`relative flex h-screen flex-col overflow-hidden bg-background text-foreground ${retro ? "retro-shell" : ""}`}>
    <Titlebar appVersion="0.7.0" retro={retro} serviceStatus="starting" brand={<MaiBotOverviewCard localVersion={undefined} launcherVersion="0.7.0" retro={retro} />} />
    <InitializationPage
      status="正在安装依赖"
      progress={42}
      active
      sourceSelector={<select aria-label="Python 依赖源" className="h-8 w-24 border border-input bg-background px-2 text-xs" value={source} onChange={(event) => setSource(event.target.value)}><option value="tuna">清华源</option><option value="pypi">官方 PyPI</option></select>}
      logs={logs}
      actions={<Button size="sm" variant="outline" onClick={() => setLogs((current) => [...current, { id: String(current.length), message: `演示日志 ${current.length + 1}：依赖安装继续…` }])}>追加演示日志</Button>}
    />
  </div>;
}

function AgreementPreview(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState(() => {
    const state = createPreviewSnapshot();
    state.startupAgreement = {
      isConfirmed: false,
      documents: (["privacy", "eula"] as const).map((id) => ({
        id,
        title: id === "privacy" ? "隐私政策" : "最终用户许可协议",
        fileName: `${id}.md`, sourcePath: "", confirmPath: "", hash: "preview",
        content: `# ${id === "privacy" ? "隐私政策" : "最终用户许可协议"}（布局演示）\n\n` + Array.from({ length: 12 }, (_, index) => `### ${index + 1}. 演示条目\n\n此处用于预览协议页面的排版和滚动效果，正式页面会显示当前 MaiBot 的完整协议文件。`).join("\n\n"),
        exists: true, confirmed: false,
      })),
    };
    return state;
  });
  const retro = document.documentElement.dataset.appearanceMode !== "modern";
  return <div className={`relative flex h-screen flex-col overflow-hidden bg-background text-foreground ${retro ? "retro-shell" : ""}`}>
    <Titlebar appVersion="0.7.0" retro={retro} brand={<MaiBotOverviewCard localVersion="1.3.8" launcherVersion="0.7.0" retro={retro} />} />
    <StartupAgreementPage snapshot={snapshot} onSnapshot={setSnapshot} />
  </div>;
}

const previewParams = new URLSearchParams(location.search);
function TitlebarTabsPreview(): React.JSX.Element {
  const [tab, setTab] = useState("maibot");
  return <Tabs value={tab} onValueChange={setTab} className="retro-shell relative flex h-screen flex-col bg-background text-foreground">
    <Titlebar appVersion="0.7.0" retro serviceStatus="running" brand={<MaiBotOverviewCard localVersion="1.3.9" launcherVersion="0.7.0" retro />} navigation={
      <TabsList className="retro-tabs retro-folder-tabs h-full">
        {[{ value: "maibot", label: "MaiBot" }, { value: "terminal", label: "终端" }, { value: "message-platform", label: "消息平台" }].map((item) => <TabsTrigger data-retro-tab-item="true" data-retro-active={tab === item.value ? "true" : undefined} key={item.value} value={item.value}>{item.label}</TabsTrigger>)}
      </TabsList>
    } />
    <main className="min-h-0 flex-1" />
  </Tabs>;
}
function PreparationNoticePreview(): React.JSX.Element {
  const service = { ...createPreviewSnapshot().services[0], status: "starting" as const, detail: "正在检查 MaiBot 启动依赖" };
  const logs = ["startup dependency upgrade: checking MaiBot dependencies in portable Python environment", "startup dependency upgrade: 1.3.9", "startup dependency upgrade completed: MaiBot package metadata -> C:\\GitHub\\MaiBotOneKey\\modules\\MaiBot\\.onekey\\environments\\2ba6-4479-a364-2049f0980bd4\\Lib\\site-packages"].map((message, index) => ({ id: String(index), message, source: "maibot" as const, stream: "system" as const, timestamp: Date.now() }));
  return <div className="retro-shell relative flex h-screen flex-col bg-background text-foreground">
    <Titlebar appVersion="0.7.0" retro serviceStatus="starting" brand={<MaiBotOverviewCard localVersion="1.3.9" launcherVersion="0.7.0" retro />} />
    <MillenniumStatusPanel phase="booting" title="MaiBot 正在启动" busy />
    <DependencyPreparationNotice service={service} logs={logs} />
  </div>;
}
function SceneTransitionPreview(): React.JSX.Element {
  const [scene, setScene] = useState(0);
  return <>
    {scene === 0 ? <AgreementPreview /> : scene === 1 ? <StartupPreview /> : <div className="retro-shell relative flex h-screen flex-col bg-background text-foreground">
      <Titlebar appVersion="0.7.0" retro serviceStatus="running" brand={<MaiBotOverviewCard localVersion="1.3.8" launcherVersion="0.7.0" retro />} />
      <main className="flex min-h-0 flex-1 items-center justify-center p-8" style={{ viewTransitionName: "startup-screen" }}>
        <Card variant="flat" className="w-full max-w-xl"><CardHeader><CardTitle>首页布局预览</CardTitle></CardHeader><CardContent><p className="text-sm">运行环境已准备就绪。</p><p className="mt-2 text-xs text-muted-foreground">正式页面会显示已经渲染就绪的 MaiBot WebUI。</p></CardContent></Card>
      </main>
    </div>}
    <button className="fixed bottom-1 left-3 z-50 text-xs" onClick={() => void transitionStartupScene(async () => {
      flushSync(() => setScene((current) => (current + 1) % 3));
    })}>预览场景变形</button>
  </>;
}
const previewTheme = previewParams.get("theme");
document.documentElement.dataset.appearanceMode = previewTheme === "modern" || previewTheme === "future-retro" ? previewTheme : "millennium";
document.documentElement.classList.toggle("dark", previewParams.get("dark") === "1");
document.body.className = "min-h-screen bg-background text-foreground";
const root = createRoot(document.getElementById("root")!);
root.render(previewParams.get("view") === "tabs" ? <TitlebarTabsPreview /> : previewParams.get("view") === "notice" ? <PreparationNoticePreview /> : previewParams.get("view") === "transition" ? <SceneTransitionPreview /> : previewParams.get("view") === "agreement" ? <AgreementPreview /> : previewParams.get("view") === "startup" ? <StartupPreview /> : <ControlsPreview />);
import.meta.hot?.dispose(() => root.unmount());
