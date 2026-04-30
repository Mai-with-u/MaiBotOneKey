import { BookOpenCheck, Loader2, Power, ShieldCheck } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { AgreementDocumentId, DesktopSnapshot } from "@shared/contracts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface StartupAgreementDialogProps {
  snapshot: DesktopSnapshot;
  onSnapshot: (snapshot: DesktopSnapshot) => void;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function StartupAgreementDialog({
  snapshot,
  onSnapshot,
}: StartupAgreementDialogProps): React.JSX.Element | null {
  const agreement = snapshot.startupAgreement;
  const [accepted, setAccepted] = useState<Record<AgreementDocumentId, boolean>>({
    eula: false,
    privacy: false,
  });
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const documents = agreement.documents;
  const activeTab = documents[0]?.id ?? "eula";
  const missingDocuments = useMemo(
    () => documents.filter((document) => !document.exists || document.error),
    [documents],
  );
  const canAccept =
    busy === null &&
    missingDocuments.length === 0 &&
    documents.length > 0 &&
    documents.every((document) => accepted[document.id]);

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

  if (agreement.isConfirmed) {
    return null;
  }

  return (
    <Dialog open={!agreement.isConfirmed}>
      <DialogContent
        size="lg"
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
      <DialogHeader
        description="首次启动前需要阅读并同意 MaiBot 的协议文件；确认后会在可写 MaiBot 目录写入确认文件。"
        icon={<BookOpenCheck className="size-4" />}
        title="MaiBot 协议确认"
        tone="primary"
      />

      <DialogBody className="space-y-4">
        <Tabs className="space-y-3" defaultValue={activeTab}>
          <TabsList className="h-8 rounded-md border border-border bg-muted/40 p-1">
            {documents.map((document) => (
              <TabsTrigger className="h-6 px-2.5 text-[11px]" key={document.id} value={document.id}>
                <ShieldCheck className="size-3" />
                {document.title}
              </TabsTrigger>
            ))}
          </TabsList>

          {documents.map((document) => (
            <TabsContent className="space-y-3" key={document.id} value={document.id}>
              <ScrollArea className="h-[min(52vh,520px)] rounded-lg border border-border bg-muted/30 px-4 py-3">
                {document.exists ? (
                  <MarkdownRenderer content={document.content} />
                ) : (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {document.error ?? `${document.fileName} 文件缺失`}
                  </div>
                )}
              </ScrollArea>
              <label className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-foreground/85">
                <input
                  checked={accepted[document.id]}
                  className="mt-0.5 size-3.5 accent-primary"
                  disabled={busy !== null || !document.exists}
                  onChange={(event) =>
                    setAccepted((current) => ({ ...current, [document.id]: event.target.checked }))
                  }
                  type="checkbox"
                />
                <span>我已阅读并同意《{document.title}》。</span>
              </label>
            </TabsContent>
          ))}
        </Tabs>

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
