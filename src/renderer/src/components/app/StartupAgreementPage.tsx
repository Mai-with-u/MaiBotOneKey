import { getDesktopSnapshot } from "@/lib/desktop-api";
import { Loader2, Power, ShieldCheck } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { transitionStartupScene } from "@/lib/startup-transition";
import "@/styles/startup-transition.css";
import type { DesktopSnapshot } from "@shared/contracts";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface StartupAgreementPageProps {
  snapshot: DesktopSnapshot;
  onSnapshot: (snapshot: DesktopSnapshot) => void;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasScrolledToBottom(element: HTMLDivElement): boolean {
  return element.scrollTop + element.clientHeight >= element.scrollHeight - 8;
}

export function StartupAgreementPage({
  snapshot,
  onSnapshot,
}: StartupAgreementPageProps): React.JSX.Element | null {
  const agreement = snapshot.startupAgreement;
  const [accepted, setAccepted] = useState(false);
  const [hasReadAll, setHasReadAll] = useState(false);
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const documents = agreement.documents;
  const missingDocuments = useMemo(
    () => documents.filter((document) => !document.exists || document.error),
    [documents],
  );
  const orderedDocuments = useMemo(
    () =>
      [...documents].sort((left, right) => {
        const order = { privacy: 0, eula: 1 };
        return order[left.id] - order[right.id];
      }),
    [documents],
  );
  const canCheck = busy === null && hasReadAll && missingDocuments.length === 0 && documents.length > 0;
  const canAccept = canCheck && accepted;

  const refreshSnapshot = useCallback(async () => {
    const nextSnapshot = await getDesktopSnapshot();
    flushSync(() => onSnapshot(nextSnapshot));
  }, [onSnapshot]);

  const acceptAgreements = useCallback(async () => {
    if (!canAccept) {
      return;
    }

    setBusy("accept");
    setError(null);
    try {
      await transitionStartupScene(async () => {
        await window.maibotDesktop?.agreements.confirm();
        await refreshSnapshot();
      });
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(null);
    }
  }, [canAccept, refreshSnapshot]);

  const declineAgreements = useCallback(async () => {
    setBusy("decline");
    setError(null);
    try {
      await window.maibotDesktop?.chooseCloseAction("quit");
    } catch (nextError) {
      setError(messageFromError(nextError));
      setBusy(null);
    }
  }, []);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (hasScrolledToBottom(event.currentTarget)) {
      setHasReadAll(true);
    }
  }, []);

  const handleViewportReady = useCallback((element: HTMLDivElement | null) => {
    if (element && element.scrollHeight <= element.clientHeight + 8) {
      setHasReadAll(true);
    }
  }, []);

  if (agreement.isConfirmed) {
    return null;
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pt-6 pb-10 sm:px-8 sm:pb-12" aria-labelledby="startup-agreement-title">
      <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-4">
        <h1 id="startup-agreement-title" className="startup-agreement-title shrink-0 text-xl font-semibold">MaiBot 协议确认</h1>
          <ScrollArea
            aria-label="协议正文"
            role="region"
            tabIndex={0}
            className="agreement-document flex-1 rounded-lg border border-border bg-muted/30 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onScroll={handleScroll}
            ref={handleViewportReady}
          >
            <div className="space-y-8">
              {orderedDocuments.map((document) => (
                <section className="space-y-3" key={document.id}>
                  <div className="agreement-document-title flex items-center gap-2 border-b border-border pb-2 text-sm font-semibold text-foreground">
                    <ShieldCheck className="size-4 text-primary" />
                    {document.title}
                  </div>
                  {document.exists ? (
                    <MarkdownRenderer content={document.content} />
                  ) : (
                    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {document.error ?? `${document.fileName} 文件缺失`}
                    </div>
                  )}
                </section>
              ))}
            </div>
          </ScrollArea>

          <label className="agreement-consent flex shrink-0 items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-foreground/85">
            <input
              checked={accepted}
              className="mt-0.5 size-3.5 accent-primary disabled:opacity-40"
              disabled={!canCheck}
              onChange={(event) => setAccepted(event.target.checked)}
              type="checkbox"
            />
            <span>
              我已阅读并同意《隐私政策》和《最终用户许可协议》。
              {!hasReadAll && <span className="ml-2 text-muted-foreground">请滚动到底部后勾选。</span>}
            </span>
          </label>

          {error ? (
            <div role="alert" className="shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
              {error}
            </div>
          ) : null}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 pt-2">
          <Button disabled={busy !== null} onClick={declineAgreements} size="sm" variant="ghost">
            {busy === "decline" ? <Loader2 className="animate-spin" /> : <Power />}
            不同意并退出
          </Button>
          <Button className="startup-agreement-continue" disabled={!canAccept} onClick={acceptAgreements} size="sm">
            {busy === "accept" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            同意并继续
          </Button>
        </div>
      </div>
    </main>
  );
}
