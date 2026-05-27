import { AlertTriangle, Copy, PowerOff, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error?: Error;
  copied?: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[renderer]", error, errorInfo);
  }

  private handleRetry = (): void => {
    this.setState({ error: undefined, copied: false });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleQuit = (): void => {
    void window.maibotDesktop?.window?.close();
  };

  private handleCopy = async (): Promise<void> => {
    const { error } = this.state;
    if (!error) {
      return;
    }
    const payload = `${error.message}\n\n${error.stack ?? ""}`.trim();
    try {
      await navigator.clipboard.writeText(payload);
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 1500);
    } catch (copyError) {
      console.warn("[renderer] copy failed", copyError);
    }
  };

  render(): ReactNode {
    const { error, copied } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <main className="grid h-screen place-items-center bg-background p-6 text-foreground">
        <div className="retro-panel retro-panel-bare w-full max-w-[640px]">
          <div className="flex items-start gap-3 border-b border-border px-6 py-5">
            <span className="grid size-10 shrink-0 place-items-center rounded-sm bg-destructive/15 text-destructive">
              <AlertTriangle className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-base font-semibold">桌面界面加载失败</h1>
                <Badge variant="danger">renderer</Badge>
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                Renderer 抛出未捕获错误。可以尝试重置错误边界，或重载窗口；至少不会再变成白屏。
              </p>
            </div>
          </div>

          <div className="space-y-3 px-6 py-5">
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-xs leading-relaxed text-destructive">
              {error.message}
            </div>
            <pre className="max-h-[280px] overflow-auto rounded-sm border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed text-foreground/80">
              {error.stack ?? error.message}
            </pre>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/40 px-6 py-3">
            <Button onClick={this.handleCopy} size="sm" variant="ghost">
              <Copy />
              {copied ? "已拷贝" : "拷贝错误"}
            </Button>
            <Button onClick={this.handleQuit} size="sm" variant="ghost">
              <PowerOff />
              退出窗口
            </Button>
            <Button onClick={this.handleRetry} size="sm" variant="outline">
              重置边界
            </Button>
            <Button onClick={this.handleReload} size="sm">
              <RotateCcw />
              重载渲染器
            </Button>
          </div>
        </div>
      </main>
    );
  }
}
