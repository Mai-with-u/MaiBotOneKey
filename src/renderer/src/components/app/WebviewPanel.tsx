import {
  ExternalLink,
  Loader2,
  Minus,
  Plus,
  RotateCw,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useShortcut } from "@/lib/use-shortcut";
import { parseMaiBotTheme, READ_MAIBOT_THEME_SCRIPT, rememberMaiBotTheme } from "@/lib/maibot-theme";
import { READ_MAIBOT_CONTENT_SCRIPT, waitForWebviewContent } from "@/lib/webview-readiness";
import { isMessagePlatformRequest } from "@/lib/webui-host-message";

interface WebviewPanelProps {
  guestCss?: string;
  onLoadStateChange?: (state: LoadState) => void;
  animateLoad?: boolean;
  readMaiBotAppearance?: boolean;
  loadingFallback?: ReactNode;
  title: string;
  url: string;
  /** When false, this panel is hidden and shortcuts are disabled. */
  active?: boolean;
  /** Changing to a truthy value forces the webview to remount. */
  reloadTrigger?: string | number | boolean | null;
  toolbarPlacement?: "internal" | "external";
  toolbarTarget?: HTMLElement | null;
  toolbarActions?: ReactNode;
  showZoomControls?: boolean;
  showExternalToolbarMetadata?: boolean;
  /** After authentication lands on the WebUI home page, continue to this URL. */
  navigationTargetUrl?: string;
  onWebuiIdentity?: (identity: { userId?: string; userName?: string }) => void;
  onMessagePlatformRequest?: () => void;
}

type LoadState = "loading" | "ready" | "error";

type WebviewElement = HTMLElement & {
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
  getURL?: () => string;
  loadURL?: (url: string) => Promise<void> | void;
  setZoomFactor?: (factor: number) => void;
  insertCSS?: (css: string) => Promise<string>;
};

type DidFailLoadEvent = Event & {
  errorCode?: number;
  validatedURL?: string;
  isMainFrame?: boolean;
};

type WebviewNavigationEvent = Event & {
  url?: string;
  isMainFrame?: boolean;
  isInPlace?: boolean;
};

const CACHE_BUST_PARAM = "__maibot_webview_cache";
const MIN_ZOOM_PERCENT = 50;
const MAX_ZOOM_PERCENT = 200;
const ZOOM_STEP_PERCENT = 10;

function isDisplayableUrl(value: string | undefined): value is string {
  return Boolean(value && value !== "about:blank");
}

function externalOpen(url: string): void {
  if (window.maibotDesktop) {
    void window.maibotDesktop.openExternal(url);
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

function withCacheBust(value: string, token: number): string {
  try {
    const nextUrl = new URL(value);
    nextUrl.searchParams.set(CACHE_BUST_PARAM, String(token));
    return nextUrl.toString();
  } catch {
    return value;
  }
}

export function WebviewPanel({
  guestCss,
  onLoadStateChange,
  animateLoad = true,
  readMaiBotAppearance = false,
  loadingFallback,
  title,
  url,
  active = true,
  reloadTrigger = null,
  toolbarPlacement = "internal",
  toolbarTarget = null,
  toolbarActions,
  showZoomControls = false,
  showExternalToolbarMetadata = true,
  navigationTargetUrl,
  onWebuiIdentity,
  onMessagePlatformRequest,
}: WebviewPanelProps): React.JSX.Element {
  const webviewRef = useRef<WebviewElement | null>(null);
  const domReadyRef = useRef(false);
  const documentVersionRef = useRef(0);
  const loadStateRef = useRef<LoadState>("loading");
  const retryCountRef = useRef(0);
  const reloadTriggerRef = useRef<WebviewPanelProps["reloadTrigger"]>(reloadTrigger);
  const navigationTargetAttemptedRef = useRef(false);
  const [loadState, setLoadStateValue] = useState<LoadState>("loading");
  useEffect(() => { onLoadStateChange?.(loadState); }, [loadState, onLoadStateChange]);
  const setLoadState = useCallback((state: LoadState) => {
    loadStateRef.current = state;
    setLoadStateValue(state);
  }, []);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [reloadKey, setReloadKey] = useState(() => Date.now());
  const [zoomPercent, setZoomPercent] = useState(100);
  const zoomPercentRef = useRef(zoomPercent);
  zoomPercentRef.current = zoomPercent;
  const webviewUrl = withCacheBust(url, reloadKey);

  const applyZoom = useCallback(() => {
    if (!showZoomControls || !domReadyRef.current) return;
    try {
      webviewRef.current?.setZoomFactor?.(zoomPercentRef.current / 100);
    } catch {
      // A navigation may temporarily detach the guest; dom-ready reapplies it.
    }
  }, [showZoomControls]);

  useEffect(() => {
    applyZoom();
  }, [applyZoom, zoomPercent]);

  const zoomControls = showZoomControls ? (
    <div aria-label="页面缩放" className="flex shrink-0 items-center gap-1" role="group">
      <Button
        aria-label="缩小页面"
        className="h-7 px-2 text-[11px]"
        disabled={loadState !== "ready" || zoomPercent <= MIN_ZOOM_PERCENT}
        onClick={() => setZoomPercent((current) => Math.max(MIN_ZOOM_PERCENT, current - ZOOM_STEP_PERCENT))}
        size="sm"
        title="缩小页面"
        variant="ghost"
      >
        <Minus />
      </Button>
      <output aria-label="页面缩放比例" aria-live="polite" className="min-w-[4ch] text-center text-[11px] tabular-nums">
        {zoomPercent}%
      </output>
      <Button
        aria-label="放大页面"
        className="h-7 px-2 text-[11px]"
        disabled={loadState !== "ready" || zoomPercent >= MAX_ZOOM_PERCENT}
        onClick={() => setZoomPercent((current) => Math.min(MAX_ZOOM_PERCENT, current + ZOOM_STEP_PERCENT))}
        size="sm"
        title="放大页面"
        variant="ghost"
      >
        <Plus />
      </Button>
    </div>
  ) : null;

  const readLiveWebviewUrl = useCallback(() => {
    if (!domReadyRef.current) {
      return undefined;
    }
    try {
      return webviewRef.current?.getURL?.();
    } catch {
      return undefined;
    }
  }, []);

  const syncCurrentUrl = useCallback((eventUrl?: string) => {
    const liveUrl = readLiveWebviewUrl();
    const nextUrl = isDisplayableUrl(liveUrl) ? liveUrl : isDisplayableUrl(eventUrl) ? eventUrl : url;
    setCurrentUrl((current) => (current === nextUrl ? current : nextUrl));
  }, [readLiveWebviewUrl, url]);

  const remountWebview = useCallback(() => {
    documentVersionRef.current += 1;
    domReadyRef.current = false;
    setLoadState("loading");
    setReloadKey((current) => Math.max(Date.now(), current + 1));
  }, [setLoadState]);

  const clearWebviewCache = useCallback(async () => {
    await window.maibotDesktop?.clearWebviewCache?.();
  }, []);

  const handleLoadUrlFailure = useCallback(() => {
    domReadyRef.current = false;
    setLoadState("error");
  }, [setLoadState]);

  const refresh = useCallback(async () => {
    retryCountRef.current = 0;
    domReadyRef.current = false;
    setLoadState("loading");
    await clearWebviewCache().catch(() => undefined);
    remountWebview();
  }, [clearWebviewCache, remountWebview, setLoadState]);

  const openExternal = useCallback(() => {
    externalOpen(currentUrl);
  }, [currentUrl]);

  useShortcut("Mod+R", refresh, { enabled: active });
  useShortcut("Mod+Shift+O", openExternal, { enabled: active });

  useEffect(() => {
    if (Object.is(reloadTriggerRef.current, reloadTrigger)) {
      return;
    }

    reloadTriggerRef.current = reloadTrigger;
    if (reloadTrigger) {
      retryCountRef.current = 0;
      remountWebview();
    }
  }, [reloadTrigger, remountWebview]);

  // Reset state when URL or remount key changes.
  useLayoutEffect(() => {
    domReadyRef.current = false;
    navigationTargetAttemptedRef.current = false;
    setLoadState("loading");
    setCurrentUrl(url);
  }, [navigationTargetUrl, url, reloadKey, setLoadState]);

  useEffect(() => { retryCountRef.current = 0; }, [url, navigationTargetUrl]);

  // Wire webview events.
  useLayoutEffect(() => {
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }

    const continueToNavigationTarget = (candidateUrl?: string): boolean => {
      if (
        !navigationTargetUrl ||
        !isDisplayableUrl(candidateUrl) ||
        navigationTargetAttemptedRef.current
      ) {
        return false;
      }

      try {
        const current = new URL(candidateUrl);
        const target = new URL(navigationTargetUrl);
        const landedOnHome = current.origin === target.origin && current.pathname === "/";
        const targetIsDifferent =
          current.pathname !== target.pathname ||
          current.search !== target.search ||
          current.hash !== target.hash;
        if (!landedOnHome || !targetIsDifferent) {
          return false;
        }

        navigationTargetAttemptedRef.current = true;
        documentVersionRef.current += 1;
        domReadyRef.current = false;
        setLoadState("loading");
        const navigation = webview.loadURL?.(navigationTargetUrl);
        if (navigation && typeof navigation.catch === "function") {
          void navigation.catch(() => {
            if (webviewRef.current === webview) handleLoadUrlFailure();
          });
        }
        return true;
      } catch {
        return false;
      }
    };
    const handleReady = (event: Event): void => {
      // Chromium also fires dom-ready / did-finish-load for its built-in
      // error page; ignore those so the overlay stays visible.
      if (loadStateRef.current === "error") {
        return;
      }
      if (event.type === "dom-ready") {
        domReadyRef.current = true;
        if (guestCss) void webview.insertCSS?.(guestCss).catch(() => undefined);
      }
      applyZoom();
      const liveUrl = readLiveWebviewUrl();
      if (continueToNavigationTarget(liveUrl)) {
        return;
      }
      syncCurrentUrl();
      if (!readMaiBotAppearance) setLoadState("ready");
      if (onWebuiIdentity && webview.executeJavaScript) {
        void webview.executeJavaScript(
          `(() => {
            const userIdKey = "maibot_webui_user_id";
            const userNameKey = "maibot_webui_user_name";
            let userId = localStorage.getItem(userIdKey);
            if (!userId) {
              userId = "webui_" + Math.random().toString(36).substr(2, 9) + "_" + Date.now().toString(36);
              localStorage.setItem(userIdKey, userId);
            }
            return JSON.stringify({
              userId,
              userName: localStorage.getItem(userNameKey) || "WebUI用户"
            });
          })()`,
          true,
        ).then((raw) => {
          if (typeof raw !== "string") {
            return;
          }
          const parsed = JSON.parse(raw) as { userId?: unknown; userName?: unknown };
          onWebuiIdentity({
            userId: typeof parsed.userId === "string" && parsed.userId.trim() ? parsed.userId.trim() : undefined,
            userName: typeof parsed.userName === "string" && parsed.userName.trim() ? parsed.userName.trim() : undefined,
          });
        }).catch(() => {
          // The embedded page may still be on an auth/error route.
        });
      }
    };
    const handleFail = (event: Event): void => {
      const failEvent = event as DidFailLoadEvent;
      syncCurrentUrl(failEvent.validatedURL);
      if (failEvent.errorCode === -3 || failEvent.isMainFrame === false) {
        return;
      }
      handleLoadUrlFailure();
    };
    const handleNavigation = (event: Event): void => {
      const navigationEvent = event as WebviewNavigationEvent;
      if (navigationEvent.isMainFrame === false) {
        return;
      }
      if (event.type === "did-start-navigation" && !navigationEvent.isInPlace) {
        documentVersionRef.current += 1;
        domReadyRef.current = false;
        setLoadState("loading");
      }
      // TanStack Router changes /auth to / without loading a new document, so
      // dom-ready/did-finish-load never fire for the home URL. Catch that SPA
      // navigation here and continue to the dedicated embedded route.
      if (continueToNavigationTarget(navigationEvent.url ?? readLiveWebviewUrl())) {
        return;
      }
      syncCurrentUrl(navigationEvent.url);
    };

    const handleHostMessage = (event: Event): void => {
      const message = event as Event & { channel: string };
      if (isMessagePlatformRequest(message.channel, readLiveWebviewUrl(), url)) {
        onMessagePlatformRequest?.();
      }
    };

    webview.addEventListener("ipc-message", handleHostMessage);

    webview.addEventListener("did-start-navigation", handleNavigation);
    webview.addEventListener("did-redirect-navigation", handleNavigation);
    webview.addEventListener("did-navigate", handleNavigation);
    webview.addEventListener("did-navigate-in-page", handleNavigation);
    webview.addEventListener("did-frame-navigate", handleNavigation);
    webview.addEventListener("did-finish-load", handleReady);
    webview.addEventListener("dom-ready", handleReady);
    webview.addEventListener("did-fail-load", handleFail);

    return () => {
      webview.removeEventListener("ipc-message", handleHostMessage);
      webview.removeEventListener("did-start-navigation", handleNavigation);
      webview.removeEventListener("did-redirect-navigation", handleNavigation);
      webview.removeEventListener("did-navigate", handleNavigation);
      webview.removeEventListener("did-navigate-in-page", handleNavigation);
      webview.removeEventListener("did-frame-navigate", handleNavigation);
      webview.removeEventListener("did-finish-load", handleReady);
      webview.removeEventListener("dom-ready", handleReady);
      webview.removeEventListener("did-fail-load", handleFail);
    };
  }, [applyZoom, guestCss, handleLoadUrlFailure, navigationTargetUrl, onWebuiIdentity, onMessagePlatformRequest, readLiveWebviewUrl, readMaiBotAppearance, reloadKey, syncCurrentUrl, url, setLoadState]);

  useEffect(() => {
    if (loadState !== "loading") return;
    const controller = new AbortController();
    const webview = webviewRef.current;
    void waitForWebviewContent(async () => {
      if (!domReadyRef.current) return false;
      const version = documentVersionRef.current;
      if (!readMaiBotAppearance) return true;
      const ready = await webview?.executeJavaScript?.(READ_MAIBOT_CONTENT_SCRIPT);
      return ready === true && domReadyRef.current && version === documentVersionRef.current &&
        loadStateRef.current === "loading";
    }, controller.signal).then((ready) => {
      if (controller.signal.aborted || loadStateRef.current !== "loading") return;
      setLoadState(ready ? "ready" : "error");
    });
    return () => controller.abort();
  }, [loadState, readMaiBotAppearance, webviewUrl, reloadKey, setLoadState]);

  useEffect(() => {
    if (loadState !== "error" || retryCountRef.current >= 3) return;
    const timer = window.setTimeout(() => {
      retryCountRef.current += 1;
      remountWebview();
    }, 1000 * 2 ** retryCountRef.current);
    return () => window.clearTimeout(timer);
  }, [loadState, reloadKey, remountWebview]);

  useEffect(() => {
    if (!readMaiBotAppearance) return;
    let disposed = false;
    let reading = false;
    const sync = async (): Promise<void> => {
      const webview = webviewRef.current;
      if (disposed || reading || !domReadyRef.current || loadStateRef.current !== "ready" || !webview?.executeJavaScript) return;
      reading = true;
      try {
        const theme = parseMaiBotTheme(await webview.executeJavaScript(READ_MAIBOT_THEME_SCRIPT));
        if (!disposed && theme) rememberMaiBotTheme(theme);
      } catch {
        // Navigation and a stopped WebUI can temporarily interrupt reading.
      } finally {
        reading = false;
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [readMaiBotAppearance, reloadKey, url]);

  const showWebview = loadState === "ready";
  const toolbar = (
    <WebviewToolbar
      embedded={toolbarPlacement === "external"}
      loadState={loadState}
      onOpenExternal={openExternal}
      onRefresh={refresh}
      showMetadata={showExternalToolbarMetadata}
      url={currentUrl}
      zoomControls={zoomControls}
    />
  );

  return (
    <>
      {toolbarPlacement === "external" && active && toolbarTarget ? createPortal(toolbar, toolbarTarget) : null}
      <section className="flex h-full min-h-0 flex-col bg-background">
      <div
        className={cn(
          "flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-3",
          toolbarPlacement === "external" && "hidden",
        )}
      >
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
            title={currentUrl}
          >
            {currentUrl}
          </code>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {zoomControls}
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
          {toolbarActions}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <webview
          // React drops unknown boolean attributes; Electron needs this attribute present.
          allowpopups={"" as unknown as boolean}
          // Keep webview in DOM while its first document loads.
          className={cn("absolute inset-0 size-full bg-background", animateLoad && "transition-opacity duration-200", showWebview ? "opacity-100" : "opacity-0")}
          key={webviewUrl}
          partition="persist:maibot-webui"
          preload={onMessagePlatformRequest ? window.maibotDesktop?.webuiPreloadUrl : undefined}
          ref={webviewRef}
          src={webviewUrl}
          webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
        />

        {!showWebview ? (
          <div
            aria-label={`正在载入 ${title}`}
            aria-live="polite"
            className="absolute inset-0 grid place-items-center bg-background"
            role="status"
          >
            {loadState === "error" && retryCountRef.current >= 3 ? (
              <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
                <p>{title} 暂不可访问，请确认服务已启动。</p>
                <Button onClick={refresh} size="sm" variant="outline"><RotateCw />重新加载</Button>
              </div>
            ) : loadingFallback ?? (
              <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="size-6 animate-spin text-primary" />
                <p>{loadState === "error" ? "连接未成功，正在重试…" : `正在载入 ${title}…`}</p>
              </div>
            )}
          </div>
        ) : null}
      </div>
      </section>
    </>
  );
}

function WebviewToolbar({
  embedded,
  loadState,
  onOpenExternal,
  onRefresh,
  showMetadata,
  url,
  zoomControls,
}: {
  embedded: boolean;
  loadState: LoadState;
  onOpenExternal: () => void;
  onRefresh: () => void;
  showMetadata: boolean;
  url: string;
  zoomControls: ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-3",
        showMetadata ? "justify-between" : "justify-end",
        embedded ? "h-full flex-1" : "h-9 shrink-0 border-b border-border bg-card px-3",
      )}
    >
      {showMetadata ? (
        <div className="flex min-w-0 items-center gap-2">
          <code
            className={cn(
              "hidden min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:block",
              embedded ? "max-w-[28vw] 2xl:max-w-[420px]" : "max-w-[420px]",
            )}
            title={url}
          >
            {url}
          </code>
        </div>
      ) : null}
      <div className="flex shrink-0 items-center gap-1">
        {zoomControls}
        <Button
          aria-label="刷新"
          className={cn(embedded ? "h-6" : "h-7", "px-2 text-[11px]")}
          onClick={onRefresh}
          size="sm"
          title="刷新 (Mod+R)"
          variant="ghost"
        >
          {loadState === "loading" ? <Loader2 className="animate-spin" /> : <RotateCw />}
        </Button>
        <Button
          aria-label="外部打开"
          className={cn(embedded ? "h-6" : "h-7", "px-2 text-[11px]")}
          onClick={onOpenExternal}
          size="sm"
          title="外部浏览器打开 (Mod+Shift+O)"
          variant="ghost"
        >
          <ExternalLink />
        </Button>
      </div>
    </div>
  );
}
