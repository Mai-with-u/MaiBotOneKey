import { PowerOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useShortcut } from "@/lib/use-shortcut";

export function CloseChoiceDialog(): React.JSX.Element | null {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    return window.maibotDesktop?.onCloseRequest(() => {
      setOpen(true);
    });
  }, []);

  const cancel = useCallback(() => setOpen(false), []);
  const minimize = useCallback(() => {
    setOpen(false);
    window.maibotDesktop?.chooseCloseAction("minimize");
  }, []);
  const quit = useCallback(() => {
    setOpen(false);
    window.maibotDesktop?.chooseCloseAction("quit");
  }, []);

  useShortcut("Escape", cancel, { enabled: open, allowInEditable: true });
  useShortcut("Enter", minimize, { enabled: open, allowInEditable: true });
  useShortcut("Mod+Q", quit, { enabled: open });

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) cancel(); }}>
      <DialogContent size="sm" showCloseButton={false}>
        <DialogHeader
          description="可以先收起窗口让服务继续运行，也可以全部退出。全部退出会先温和停止托管进程，超时后再强制结束。"
          icon={<PowerOff className="size-4" />}
          title="关闭 MaiBot OneKey？"
          tone="danger"
        />
        <DialogFooter>
          <Button onClick={cancel} size="sm" variant="ghost">
            取消
            <Kbd className="ml-1" keys="Esc" size="xs" tone="muted" />
          </Button>
          <Button onClick={minimize} size="sm" variant="outline">
            最小化
            <Kbd className="ml-1" keys="Enter" size="xs" tone="muted" />
          </Button>
          <Button onClick={quit} size="sm" variant="destructive">
            全部退出
            <Kbd className="ml-1" keys="Mod+Q" size="xs" tone="inverse" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
