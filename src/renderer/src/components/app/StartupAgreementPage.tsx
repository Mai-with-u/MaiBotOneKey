import { getDesktopSnapshot } from "@/lib/desktop-api";
import { Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useState } from "react";
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

export function StartupAgreementPage({
  snapshot,
  onSnapshot,
}: StartupAgreementPageProps): React.JSX.Element | null {
  const agreement = snapshot.startupAgreement;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const documents = agreement.documents;

  const refreshSnapshot = useCallback(async () => {
    const nextSnapshot = await getDesktopSnapshot();
    flushSync(() => onSnapshot(nextSnapshot));
  }, [onSnapshot]);

  const dismissNotice = useCallback(async () => {
    if (busy) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await transitionStartupScene(async () => {
        await window.maibotDesktop?.agreements.dismiss();
        await refreshSnapshot();
      });
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setBusy(false);
    }
  }, [busy, refreshSnapshot]);

  if (agreement.isDismissed) {
    return null;
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pt-6 pb-10 sm:px-8 sm:pb-12" aria-labelledby="startup-agreement-title">
      <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-4">
        <h1 id="startup-agreement-title" className="startup-agreement-title shrink-0 text-xl font-semibold">使用须知与隐私说明</h1>
          <ScrollArea
            aria-label="须知正文"
            role="region"
            tabIndex={0}
            className="agreement-document flex-1 rounded-lg border border-border bg-muted/30 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <div className="space-y-8">
              {documents.map((document) => (
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

          {error ? (
            <div role="alert" className="shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
              {error}
            </div>
          ) : null}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 pt-2">
          <Button className="startup-agreement-continue" disabled={busy} onClick={dismissNotice} size="sm">
            {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            继续
          </Button>
        </div>
      </div>
    </main>
  );
}
