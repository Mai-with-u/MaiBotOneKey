import {
  ExternalLink,
  Loader2,
  RotateCw,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useShortcut } from "@/lib/use-shortcut";

interface WebviewPanelProps {
  title: string;
  url: string;
  /** When false, this panel is hidden and shortcuts are disabled. */
  active?: boolean;
  /** Changing to a truthy value forces the webview to remount. */
  reloadTrigger?: string | number | boolean | null;
  toolbarPlacement?: "internal" | "external";
  toolbarTarget?: HTMLElement | null;
  showExternalToolbarMetadata?: boolean;
  /** After authentication lands on the WebUI home page, continue to this URL. */
  navigationTargetUrl?: string;
  onWebuiIdentity?: (identity: { userId?: string; userName?: string }) => void;
}

type LoadState = "idle" | "loading" | "ready" | "error";

type WebviewElement = HTMLElement & {
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
  getURL?: () => string;
  loadURL?: (url: string) => Promise<void> | void;
  reload?: () => void;
  reloadIgnoringCache?: () => void;
};

type DidFailLoadEvent = Event & {
  errorCode?: number;
  validatedURL?: string;
  isMainFrame?: boolean;
};

type WebviewNavigationEvent = Event & {
  url?: string;
  isMainFrame?: boolean;
};

const CACHE_BUST_PARAM = "__maibot_webview_cache";

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
  title,
  url,
  active = true,
  reloadTrigger = null,
  toolbarPlacement = "internal",
  toolbarTarget = null,
  showExternalToolbarMetadata = true,
  navigationTargetUrl,
  onWebuiIdentity,
}: WebviewPanelProps): React.JSX.Element {
  const webviewRef = useRef<WebviewElement | null>(null);
  const domReadyRef = useRef(false);
  const failedRef = useRef(false);
  const hasRenderedPageRef = useRef(false);
  const reloadTriggerRef = useRef<WebviewPanelProps["reloadTrigger"]>(reloadTrigger);
  const navigationTargetAttemptedRef = useRef(false);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [hasRenderedPage, setHasRenderedPage] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [reloadKey, setReloadKey] = useState(0);
  const [cacheBustToken, setCacheBustToken] = useState(() => Date.now());
  const webviewUrl = withCacheBust(url, cacheBustToken);

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
    domReadyRef.current = false;
    setLoadState("loading");
    setCacheBustToken(Date.now());
    setReloadKey((current) => current + 1);
  }, []);

  const clearWebviewCache = useCallback(async () => {
    await window.maibotDesktop?.clearWebviewCache?.();
  }, []);

  const handleLoadUrlFailure = useCallback(() => {
    if (hasRenderedPageRef.current) {
      setLoadState("ready");
      return;
    }

    failedRef.current = true;
    domReadyRef.current = false;
    setLoadState("error");
  }, []);

  const refresh = useCallback(async () => {
    setLoadState("loading");
    await clearWebviewCache().catch(() => undefined);

    const webview = webviewRef.current;
    if (domReadyRef.current && webview?.loadURL) {
      try {
        // A dedicated embedded panel should refresh its actual destination,
        // not replay the one-time token authentication entry page.
        const nextUrl = withCacheBust(navigationTargetUrl ?? url, Date.now());
        const navigation = webview.loadURL(nextUrl);
        if (navigation && typeof navigation.catch === "function") {
          void navigation.catch(handleLoadUrlFailure);
        }
        return;
      } catch {
        /* fall through to reload/remount */
      }
    }
    if (domReadyRef.current && (webview?.reloadIgnoringCache || webview?.reload)) {
      try {
        webview.reloadIgnoringCache?.() ?? webview.reload?.();
        return;
      } catch {
        /* fall through to remount */
      }
    }

    remountWebview();
  }, [clearWebviewCache, handleLoadUrlFailure, navigationTargetUrl, remountWebview, url]);

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
      void clearWebviewCache()
        .catch(() => undefined)
        .finally(remountWebview);
    }
  }, [clearWebviewCache, reloadTrigger, remountWebview]);

  // Reset state when URL or remount key changes.
  useLayoutEffect(() => {
    domReadyRef.current = false;
    failedRef.current = false;
    hasRenderedPageRef.current = false;
    navigationTargetAttemptedRef.current = false;
    setHasRenderedPage(false);
    setLoadState("loading");
    setCurrentUrl(url);
  }, [navigationTargetUrl, url, reloadKey, webviewUrl]);

  // Wire webview events.
  useLayoutEffect(() => {
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }

    const handleStart = (): void => {
      // A new navigation starts. Before the first successful page load, show
      // the connection fallback; after that, keep WebUI route changes visible.
      failedRef.current = false;
      syncCurrentUrl();
      setLoadState(hasRenderedPageRef.current ? "ready" : "loading");
    };
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
        setLoadState("loading");
        const navigation = webview.loadURL?.(navigationTargetUrl);
        if (navigation && typeof navigation.catch === "function") {
          void navigation.catch(handleLoadUrlFailure);
        }
        return true;
      } catch {
        return false;
      }
    };
    const handleReady = (event: Event): void => {
      // Chromium also fires dom-ready / did-finish-load for its built-in
      // error page; ignore those so the overlay stays visible.
      if (failedRef.current) {
        return;
      }
      if (event.type === "dom-ready") {
        domReadyRef.current = true;
      }
      const liveUrl = readLiveWebviewUrl();
      if (continueToNavigationTarget(liveUrl)) {
        return;
      }
      syncCurrentUrl();
      hasRenderedPageRef.current = true;
      setHasRenderedPage(true);
      setLoadState("ready");
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
      if (hasRenderedPageRef.current) {
        setLoadState("ready");
        return;
      }

      failedRef.current = true;
      domReadyRef.current = false;
      setLoadState("error");
    };
    const handleNavigation = (event: Event): void => {
      const navigationEvent = event as WebviewNavigationEvent;
      if (navigationEvent.isMainFrame === false) {
        return;
      }
      // TanStack Router changes /auth to / without loading a new document, so
      // dom-ready/did-finish-load never fire for the home URL. Catch that SPA
      // navigation here and continue to the dedicated embedded route.
      if (continueToNavigationTarget(navigationEvent.url ?? readLiveWebviewUrl())) {
        return;
      }
      syncCurrentUrl(navigationEvent.url);
    };

    webview.addEventListener("did-start-loading", handleStart);
    webview.addEventListener("did-start-navigation", handleNavigation);
    webview.addEventListener("did-redirect-navigation", handleNavigation);
    webview.addEventListener("did-navigate", handleNavigation);
    webview.addEventListener("did-navigate-in-page", handleNavigation);
    webview.addEventListener("did-frame-navigate", handleNavigation);
    webview.addEventListener("did-finish-load", handleReady);
    webview.addEventListener("dom-ready", handleReady);
    webview.addEventListener("did-fail-load", handleFail);

    return () => {
      webview.removeEventListener("did-start-loading", handleStart);
      webview.removeEventListener("did-start-navigation", handleNavigation);
      webview.removeEventListener("did-redirect-navigation", handleNavigation);
      webview.removeEventListener("did-navigate", handleNavigation);
      webview.removeEventListener("did-navigate-in-page", handleNavigation);
      webview.removeEventListener("did-frame-navigate", handleNavigation);
      webview.removeEventListener("did-finish-load", handleReady);
      webview.removeEventListener("dom-ready", handleReady);
      webview.removeEventListener("did-fail-load", handleFail);
    };
  }, [handleLoadUrlFailure, navigationTargetUrl, onWebuiIdentity, readLiveWebviewUrl, reloadKey, syncCurrentUrl, url]);

  const showLoading = !hasRenderedPage && (loadState === "idle" || loadState === "loading");
  const showWebview = hasRenderedPage || loadState === "ready" || loadState === "error";
  const toolbar = (
    <WebviewToolbar
      embedded={toolbarPlacement === "external"}
      loadState={loadState}
      onOpenExternal={openExternal}
      onRefresh={refresh}
      showMetadata={showExternalToolbarMetadata}
      title={title}
      url={currentUrl}
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
          // Keep webview in DOM while its first document loads.
          className={`absolute inset-0 size-full bg-white transition-opacity duration-200 ${
            showWebview ? "opacity-100" : "opacity-0"
          }`}
          key={`${webviewUrl}:${reloadKey}`}
          partition="persist:maibot-webui"
          ref={webviewRef}
          src={webviewUrl}
          webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
        />

        {showLoading ? (
          <div
            aria-label={`正在载入 ${title}`}
            aria-live="polite"
            className="absolute inset-0 grid place-items-center bg-background"
            role="status"
          >
            <Loader2 className="size-6 animate-spin text-primary" />
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
  title,
  url,
}: {
  embedded: boolean;
  loadState: LoadState;
  onOpenExternal: () => void;
  onRefresh: () => void;
  showMetadata: boolean;
  title: string;
  url: string;
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
        <Button
          aria-label="刷新"
          className="h-7 px-2 text-[11px]"
          onClick={onRefresh}
          size="sm"
          title="刷新 (Mod+R)"
          variant="ghost"
        >
          {loadState === "loading" ? <Loader2 className="animate-spin" /> : <RotateCw />}
        </Button>
        <Button
          aria-label="外部打开"
          className="h-7 px-2 text-[11px]"
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
