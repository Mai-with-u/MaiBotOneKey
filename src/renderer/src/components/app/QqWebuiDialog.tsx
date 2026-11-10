import type { QqBackend } from "@shared/contracts";
import { useState } from "react";
import { SNOWLUMA_WEBUI_LAYOUT_CSS } from "@/lib/snowluma-webui-layout";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent } from "@/components/ui/dialog";
import { WebviewPanel } from "./WebviewPanel";

interface QqWebuiDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  backend: QqBackend;
  url: string;
}

export function QqWebuiDialog({ open, onOpenChange, backend, url }: QqWebuiDialogProps): React.JSX.Element {
  const [snowLumaHintDismissed, setSnowLumaHintDismissed] = useState(() => localStorage.getItem("maibot-snowluma-hint-dismissed") === "true");
  const title = `${backend === "snowluma" ? "SnowLuma" : "NapCat"} WebUI`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className={`${backend === "snowluma" ? "h-[calc(100dvh-2rem)]" : "h-[calc(100vh-4rem)]"} grid-rows-[minmax(0,1fr)_auto] sm:max-w-[1180px]`} showCloseButton={false} size="xl">
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        <DialogBody className="overflow-hidden p-0">
          <WebviewPanel
            active={open}
            guestCss={backend === "snowluma" ? SNOWLUMA_WEBUI_LAYOUT_CSS : undefined}
            showZoomControls={backend === "snowluma"}
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
        {backend === "snowluma" && !snowLumaHintDismissed ? (
          <section className="max-h-[25vh] overflow-auto border-t border-border bg-muted/40 px-4 py-2">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold leading-5">在 SnowLuma 中连接 QQ</h2>
              <Button size="sm" variant="ghost" onClick={() => {
                localStorage.setItem("maibot-snowluma-hint-dismissed", "true");
                setSnowLumaHintDismissed(true);
              }}>不再显示</Button>
            </div>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs leading-5">
              <li>登录需要连接麦麦的 QQ 账号</li>
              <li>
                已配置机器人 QQ 号时会自动检测并注入，QQ 后续启动或重启也会继续检测。
              </li>
              <li>若自动注入失败，可进入 <strong className="text-primary">进程注入</strong> 页面查看状态或手动 <strong className="text-primary">加载</strong>。</li>
            </ol>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
