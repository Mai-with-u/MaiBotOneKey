import { BookOpenCheck, Loader2, Power, ShieldCheck } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { DesktopSnapshot } from "@shared/contracts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface StartupAgreementDialogProps {
  snapshot: DesktopSnapshot;
  onSnapshot: (snapshot: DesktopSnapshot) => void;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasScrolledToBottom(element: HTMLDivElement): boolean {
  return element.scrollTop + element.clientHeight >= element.scrollHeight - 8;
}

export function StartupAgreementDialog({
  snapshot,
  onSnapshot,
}: StartupAgreementDialogProps): React.JSX.Element | null {
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
    const nextSnapshot = await window.maibotDesktop?.getSnapshot();
    if (nextSnapshot) {
      onSnapshot(nextSnapshot);
    }
  }, [onSnapshot]);

  const acceptAgreements = useCallback(async () => {
    if (!canAccept) {
      return;
    }

    setBusy("accept");
    setError(null);
    try {
      await window.maibotDesktop?.agreements.confirm();
      await refreshSnapshot();
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
    <Dialog open={!agreement.isConfirmed}>
      <DialogContent
        size="lg"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader
          description="首次启动前需要阅读并同意 MaiBot 的协议文件；确认后会在可写 MaiBot 目录写入确认文件。"
          icon={<BookOpenCheck className="size-4" />}
          title="MaiBot 协议确认"
          tone="primary"
        />

        <DialogBody className="space-y-4">
          <ScrollArea
            className="h-[min(56vh,560px)] rounded-lg border border-border bg-muted/30 px-4 py-3"
            onScroll={handleScroll}
            ref={handleViewportReady}
          >
            <div className="space-y-8">
              {orderedDocuments.map((document) => (
                <section className="space-y-3" key={document.id}>
                  <div className="flex items-center gap-2 border-b border-border pb-2 text-sm font-semibold text-foreground">
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

          <label className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-foreground/85">
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
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
              {error}
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter className="justify-between">
          <Button disabled={busy !== null} onClick={declineAgreements} size="sm" variant="ghost">
            {busy === "decline" ? <Loader2 className="animate-spin" /> : <Power />}
            不同意并退出
          </Button>
          <Button disabled={!canAccept} onClick={acceptAgreements} size="sm">
            {busy === "accept" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            同意并继续
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
