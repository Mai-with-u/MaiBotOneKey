import {
  AlertTriangle,
  ExternalLink,
  Globe,
  Loader2,
  PlugZap,
  RotateCw,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useShortcut } from "@/lib/use-shortcut";

interface WebviewPanelProps {
  title: string;
  url: string;
  emptyText: string;
  /** When false, this panel is hidden and shortcuts are disabled. */
  active?: boolean;
}

type LoadState = "idle" | "loading" | "ready" | "error";

type WebviewElement = HTMLElement & {
  getURL?: () => string;
  loadURL?: (url: string) => void;
  reload?: () => void;
};

type DidFailLoadEvent = Event & {
  errorCode?: number;
  errorDescription?: string;
  validatedURL?: string;
  isMainFrame?: boolean;
};

const LOAD_TIMEOUT_MS = 12_000;
const AUTO_RETRY_SECONDS = 8;

function externalOpen(url: string): void {
  if (window.maibotDesktop) {
    void window.maibotDesktop.openExternal(url);
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

function describeError(message: string | null): string {
  if (!message) {
    return "WebUI 暂时不可访问";
  }
  if (/ERR_CONNECTION_REFUSED/i.test(message)) {
    return "服务端口拒绝连接，可能进程还未启动或已退出。";
  }
  if (/ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE/i.test(message)) {
    return "无法解析或访问目标地址。";
  }
  if (/ERR_TIMED_OUT/i.test(message)) {
    return "等待 WebUI 响应超时。";
  }
  if (/ERR_CONNECTION_RESET/i.test(message)) {
    return "连接被重置，对端可能正在重启。";
  }
  return message;
}

export function WebviewPanel({
  title,
  url,
  emptyText,
  active = true,
}: WebviewPanelProps): React.JSX.Element {
  const webviewRef = useRef<WebviewElement | null>(null);
  const domReadyRef = useRef(false);
  const failedRef = useRef(false);
  const hasRenderedPageRef = useRef(false);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [hasRenderedPage, setHasRenderedPage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [retryIn, setRetryIn] = useState<number | null>(null);

  const remountWebview = useCallback(() => {
    domReadyRef.current = false;
    setLoadState("loading");
    setErrorMessage(null);
    setReloadKey((current) => current + 1);
  }, []);

  const refresh = useCallback(() => {
    setLoadState("loading");
    setErrorMessage(null);

    const webview = webviewRef.current;
    if (domReadyRef.current && webview?.reload) {
      try {
        webview.reload();
        return;
      } catch {
        /* fall through to remount */
      }
    }

    remountWebview();
  }, [remountWebview]);

  const openExternal = useCallback(() => {
    externalOpen(url);
  }, [url]);

  useShortcut("Mod+R", refresh, { enabled: active });
  useShortcut("Mod+Shift+O", openExternal, { enabled: active });

  // Reset state when URL or remount key changes.
  useEffect(() => {
    domReadyRef.current = false;
    failedRef.current = false;
    hasRenderedPageRef.current = false;
    setHasRenderedPage(false);
    setLoadState("loading");
    setErrorMessage(null);
    setRetryIn(null);
  }, [url, reloadKey]);

  // Wire webview events.
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }

    const handleStart = (): void => {
      // A new navigation starts. Before the first successful page load, show
      // the connection fallback; after that, keep WebUI route changes visible.
      failedRef.current = false;
      setLoadState(hasRenderedPageRef.current ? "ready" : "loading");
      setErrorMessage(null);
    };
    const handleReady = (): void => {
      // Chromium also fires dom-ready / did-finish-load for its built-in
      // error page; ignore those so the overlay stays visible.
      if (failedRef.current) {
        return;
      }
      domReadyRef.current = true;
      hasRenderedPageRef.current = true;
      setHasRenderedPage(true);
      setLoadState("ready");
      setErrorMessage(null);
      setRetryIn(null);
    };
    const handleFail = (event: Event): void => {
      const failEvent = event as DidFailLoadEvent;
      if (failEvent.errorCode === -3 || failEvent.isMainFrame === false) {
        return;
      }
      if (hasRenderedPageRef.current) {
        setLoadState("ready");
        setErrorMessage(null);
        return;
      }

      failedRef.current = true;
      domReadyRef.current = false;
      setLoadState("error");
      setErrorMessage(failEvent.errorDescription ?? null);
    };

    webview.addEventListener("did-start-loading", handleStart);
    webview.addEventListener("did-finish-load", handleReady);
    webview.addEventListener("dom-ready", handleReady);
    webview.addEventListener("did-fail-load", handleFail);

    return () => {
      webview.removeEventListener("did-start-loading", handleStart);
      webview.removeEventListener("did-finish-load", handleReady);
      webview.removeEventListener("dom-ready", handleReady);
      webview.removeEventListener("did-fail-load", handleFail);
    };
  }, [reloadKey, url]);

  // Loading watchdog: if it stays in "loading" too long without ready/fail,
  // flip to error so the user gets the default panel instead of a white screen.
  useEffect(() => {
    if (loadState !== "loading") {
      return;
    }
    const timer = window.setTimeout(() => {
      setLoadState("error");
      setErrorMessage("等待 WebUI 响应超时");
    }, LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [loadState, reloadKey]);

  // Auto-retry countdown while in error state and panel is active.
  useEffect(() => {
    if (loadState !== "error" || !active) {
      setRetryIn(null);
      return;
    }
    setRetryIn(AUTO_RETRY_SECONDS);
    const interval = window.setInterval(() => {
      setRetryIn((current) => {
        if (current === null) return null;
        if (current <= 1) {
          window.clearInterval(interval);
          remountWebview();
          return null;
        }
        return current - 1;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [loadState, active, remountWebview]);

  const cancelAutoRetry = useCallback(() => {
    setRetryIn(null);
  }, []);

  const friendlyError = describeError(errorMessage);
  const showOverlay = !hasRenderedPage && loadState !== "ready";
  const showWebview = hasRenderedPage || loadState === "ready";

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-3 ">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="shrink-0 text-[12px] font-semibold">{title}</h2>
          <Badge
            dot
            variant={
              loadState === "ready"
                ? "success"
                : loadState === "error"
                  ? "danger"
                  : loadState === "loading"
                    ? "warning"
                    : "secondary"
            }
          >
            {loadState === "ready"
              ? "已载入"
              : loadState === "error"
                ? "未连接"
                : loadState === "loading"
                  ? "载入中"
                  : "待载入"}
          </Badge>
          <span className="hidden h-3 w-px bg-border sm:block" />
          <code
            className="hidden min-w-0 max-w-[420px] truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:block"
            title={url}
          >
            {url}
          </code>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label="刷新"
            className="h-7 px-2 text-[11px]"
            onClick={refresh}
            size="sm"
            title="刷新 (Mod+R)"
            variant="ghost"
          >
            {loadState === "loading" ? <Loader2 className="animate-spin" /> : <RotateCw />}
          </Button>
          <Button
            aria-label="外部打开"
            className="h-7 px-2 text-[11px]"
            onClick={openExternal}
            size="sm"
            title="外部浏览器打开 (Mod+Shift+O)"
            variant="ghost"
          >
            <ExternalLink />
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <webview
          // Keep webview in DOM but invisible until ready, so the default panel
          // covers the white page instead of flashing it through.
          className={`absolute inset-0 size-full bg-white transition-opacity duration-200 ${
            showWebview ? "opacity-100" : "opacity-0"
          }`}
          key={`${url}:${reloadKey}`}
          partition="persist:maibot-webui"
          ref={webviewRef}
          src={url}
          webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
        />

        {showOverlay ? (
          <DefaultWebviewPanel
            emptyText={emptyText}
            errorMessage={loadState === "error" ? friendlyError : null}
            loadState={loadState}
            onCancelAutoRetry={cancelAutoRetry}
            onOpenExternal={openExternal}
            onRetry={loadState === "error" ? remountWebview : refresh}
            retryIn={retryIn}
            title={title}
            url={url}
          />
        ) : null}
      </div>
    </section>
  );
}

function DefaultWebviewPanel({
  emptyText,
  errorMessage,
  loadState,
  onCancelAutoRetry,
  onOpenExternal,
  onRetry,
  retryIn,
  title,
  url,
}: {
  emptyText: string;
  errorMessage: string | null;
  loadState: LoadState;
  onCancelAutoRetry: () => void;
  onOpenExternal: () => void;
  onRetry: () => void;
  retryIn: number | null;
  title: string;
  url: string;
}): React.JSX.Element {
  const isError = loadState === "error";
  const Icon = isError ? AlertTriangle : loadState === "loading" ? PlugZap : Globe;
  const tone = isError
    ? "border-destructive/30 bg-destructive/15 text-destructive"
    : "border-primary/25 bg-primary/12 text-primary";

  const headline = isError
    ? `连不上 ${title}`
    : loadState === "loading"
      ? `正在连接 ${title}…`
      : `准备连接 ${title}`;
  const description = isError
    ? errorMessage ?? "WebUI 暂时不可访问"
    : emptyText;

  return (
    <div
      aria-live="polite"
      className="absolute inset-0 grid place-items-center overflow-auto bg-background/95 p-6 "
    >
      <div className="retro-panel retro-panel-bare w-full max-w-[520px] p-6">
        <div className="flex items-start gap-3">
          <span className={`grid size-10 shrink-0 place-items-center rounded-sm border ${tone}`}>
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold">{headline}</h3>
              <Badge variant={isError ? "danger" : "secondary"}>
                {isError ? "未连接" : loadState === "loading" ? "载入中" : "待载入"}
              </Badge>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
            <code
              className="mt-3 block min-w-0 break-all rounded-md border border-border bg-muted px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/80"
              title={url}
            >
              {url}
            </code>
          </div>
        </div>

        {isError ? (
          <ul className="retro-control mt-5 space-y-1.5 p-3 text-[12px] leading-relaxed text-muted-foreground">
            <li className="flex items-start gap-2">
              <Sparkles className="mt-0.5 size-3 shrink-0 text-primary" />
              先在「设置状态」里确认对应服务正在运行。
            </li>
            <li className="flex items-start gap-2">
              <Sparkles className="mt-0.5 size-3 shrink-0 text-primary" />
              端口冲突时把占用进程结束，或修改服务端口。
            </li>
            <li className="flex items-start gap-2">
              <Sparkles className="mt-0.5 size-3 shrink-0 text-primary" />
              首次启动需要等待 WebUI 完成加载，可手动重试。
            </li>
          </ul>
        ) : (
          <div className="mt-5 flex items-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-primary" />
            正在与 WebUI 建立连接，请稍候…
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {isError && retryIn !== null ? (
            <Button onClick={onCancelAutoRetry} size="sm" variant="ghost">
              {retryIn}s 后自动重试 · 暂停
            </Button>
          ) : null}
          <Button onClick={onOpenExternal} size="sm" variant="outline">
            <ExternalLink />
            外部打开
            <Kbd className="ml-1" keys="Mod+Shift+O" size="xs" tone="muted" />
          </Button>
          <Button onClick={onRetry} size="sm">
            <RotateCw />
            {isError ? "立即重试" : "重新载入"}
            <Kbd className="ml-1" keys="Mod+R" size="xs" tone="inverse" />
          </Button>
        </div>
      </div>
    </div>
  );
}
