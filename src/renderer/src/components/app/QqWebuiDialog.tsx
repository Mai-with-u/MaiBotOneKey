import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent } from "@/components/ui/dialog";
import { WebviewPanel } from "./WebviewPanel";

interface QqWebuiDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
}

export function QqWebuiDialog({ open, onOpenChange, url }: QqWebuiDialogProps): React.JSX.Element {
  const title = "NapCat WebUI";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="h-[calc(100vh-4rem)] grid-rows-[minmax(0,1fr)] sm:max-w-[1180px]" showCloseButton={false} size="xl">
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        <DialogBody className="overflow-hidden p-0">
          <WebviewPanel
            active={open}
            title={title}
            url={url}
            toolbarActions={(
              <DialogClose asChild>
                <Button aria-label="关闭 WebUI" className="h-7 px-2 text-[11px]" size="sm" title="关闭 WebUI" variant="ghost">
                  <X />
                </Button>
              </DialogClose>
            )}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
