import {
  Bot,
  CircleAlert,
  ImageIcon,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  Settings,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalChatEvent, LocalChatImageAttachment, LocalChatMessageEvent, ServiceDescriptor } from "@shared/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type ConnectionState = "idle" | "connecting" | "connected" | "error";

interface ChatMessage {
  id: string;
  role: "user" | "bot" | "system" | "error";
  content: string;
  timestamp: number;
  sender?: string;
  images?: LocalChatImageAttachment[];
}

const DEFAULT_USER_NAME = "本地用户";
const DEFAULT_ADAPTER_PORT = "8000";
const ADAPTER_PORT_STORAGE_KEY = "maibot.localChat.adapterPort";
const USER_NAME_STORAGE_KEY = "maibot.localChat.userName";
const USER_AVATAR_STORAGE_KEY = "maibot.localChat.userAvatar";
const BOT_AVATAR_STORAGE_KEY = "maibot.localChat.botAvatar";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function maibotOrigin(service: ServiceDescriptor | undefined): string {
  try {
    return new URL(service?.url ?? "http://127.0.0.1:8001").origin;
  } catch {
    return "http://127.0.0.1:8001";
  }
}

function toChatMessage(event: LocalChatMessageEvent): ChatMessage {
  return {
    id: event.id,
    role: event.role,
    content: event.content,
    timestamp: event.timestamp,
    sender: event.sender,
    images: event.images,
  };
}

function appendMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  if (messages.some((item) => item.id === message.id)) {
    return messages;
  }
  return [...messages, message].slice(-120);
}

function attachmentDataUrl(image: LocalChatImageAttachment): string {
  return image.dataUrl ?? `data:${image.mimeType};base64,${image.base64}`;
}

function readImageFile(file: File): Promise<LocalChatImageAttachment> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("请选择图片文件"));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error("图片不能超过 8 MB"));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const base64 = dataUrl.slice(dataUrl.indexOf(";base64,") + 8);
      resolve({ name: file.name, mimeType: file.type, base64, dataUrl });
    };
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function AvatarButton({
  avatar,
  fallback,
  icon,
  onPick,
  title,
}: {
  avatar: string;
  fallback: React.ReactNode;
  icon: React.ReactNode;
  onPick: (file: File) => void;
  title: string;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <button
        className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-secondary text-secondary-foreground transition-colors hover:border-primary/60"
        onClick={() => inputRef.current?.click()}
        title={title}
        type="button"
      >
        {avatar ? <img alt="" className="size-full object-cover" src={avatar} /> : fallback}
      </button>
      <input
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            onPick(file);
          }
          event.target.value = "";
        }}
        ref={inputRef}
        type="file"
      />
      <span className="sr-only">{icon}</span>
    </>
  );
}

export function LocalChatPanel({
  active,
  maibotService,
}: {
  active: boolean;
  maibotService: ServiceDescriptor | undefined;
}): React.JSX.Element {
  const origin = useMemo(() => maibotOrigin(maibotService), [maibotService]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [userName, setUserName] = useState(() => localStorage.getItem(USER_NAME_STORAGE_KEY) ?? DEFAULT_USER_NAME);
  const [adapterPort, setAdapterPort] = useState(() => localStorage.getItem(ADAPTER_PORT_STORAGE_KEY) ?? DEFAULT_ADAPTER_PORT);
  const [userAvatar, setUserAvatar] = useState(() => localStorage.getItem(USER_AVATAR_STORAGE_KEY) ?? "");
  const [botAvatar, setBotAvatar] = useState(() => localStorage.getItem(BOT_AVATAR_STORAGE_KEY) ?? "");
  const [pendingImages, setPendingImages] = useState<LocalChatImageAttachment[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(ADAPTER_PORT_STORAGE_KEY, adapterPort);
  }, [adapterPort]);

  useEffect(() => {
    localStorage.setItem(USER_NAME_STORAGE_KEY, userName);
  }, [userName]);

  useEffect(() => {
    if (userAvatar) {
      localStorage.setItem(USER_AVATAR_STORAGE_KEY, userAvatar);
    } else {
      localStorage.removeItem(USER_AVATAR_STORAGE_KEY);
    }
  }, [userAvatar]);

  useEffect(() => {
    if (botAvatar) {
      localStorage.setItem(BOT_AVATAR_STORAGE_KEY, botAvatar);
    } else {
      localStorage.removeItem(BOT_AVATAR_STORAGE_KEY);
    }
  }, [botAvatar]);

  const connect = useCallback(async () => {
    setState("connecting");
    setError(null);
    setIsTyping(false);

    try {
      if (maibotService?.status !== "running") {
        throw new Error("请先启动 MaiBot Core");
      }

      const port = Number(adapterPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("适配器端口必须在 1-65535 之间");
      }

      const nextState = await window.maibotDesktop?.localChat.connect({ port });
      setState(nextState ?? "error");
      const history = await window.maibotDesktop?.localChat.listMessages();
      if (history) {
        setMessages(history.map(toChatMessage));
      }
      if (nextState !== "connected") {
        setError("本地适配器未连接，请确认 MaiBot Core 的 maim_message 服务已启动");
      }
    } catch (nextError) {
      setState("error");
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [adapterPort, maibotService?.status]);

  useEffect(() => {
    if (!active) {
      setState("idle");
      setIsTyping(false);
      return undefined;
    }

    const bridge = window.maibotDesktop?.localChat;
    const unsubscribe = bridge?.onEvent((event: LocalChatEvent) => {
      if ("type" in event) {
        setState(event.state);
        if (event.state === "connected") {
          setError(null);
        }
        return;
      }

      setIsTyping(false);
      setMessages((current) => appendMessage(current, toChatMessage(event)));
    });

    void connect();
    return () => {
      unsubscribe?.();
    };
  }, [active, connect]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isTyping]);

  const pickAvatar = useCallback(async (file: File, target: "bot" | "user") => {
    try {
      const image = await readImageFile(file);
      if (target === "bot") {
        setBotAvatar(attachmentDataUrl(image));
      } else {
        setUserAvatar(attachmentDataUrl(image));
      }
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, []);

  const addImages = useCallback(async (files: FileList | null) => {
    if (!files?.length) {
      return;
    }
    try {
      const images = await Promise.all(Array.from(files).map(readImageFile));
      setPendingImages((current) => [...current, ...images].slice(0, 6));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, []);

  const sendMessage = useCallback(async () => {
    const content = draft.trim();
    if ((!content && pendingImages.length === 0) || state !== "connected") {
      return;
    }
    const images = pendingImages;
    setDraft("");
    setPendingImages([]);
    setIsTyping(true);

    try {
      const sent = await window.maibotDesktop?.localChat.send({ content, images, userName, port: Number(adapterPort) });
      if (sent) {
        setMessages((current) => appendMessage(current, toChatMessage(sent)));
      }
    } catch (nextError) {
      setIsTyping(false);
      setState("error");
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setDraft(content);
      setPendingImages(images);
    }
  }, [adapterPort, draft, pendingImages, state, userName]);

  const connected = state === "connected";
  const canSend = connected && (draft.trim() || pendingImages.length > 0);

  return (
    <>
      <section className={cn("h-full min-h-0 flex-col bg-background", active ? "flex" : "hidden")}>
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare className="size-4 text-primary" />
          <h2 className="text-sm font-semibold">随便聊聊</h2>
          <Badge
            dot
            variant={connected ? "success" : state === "connecting" ? "warning" : state === "error" ? "danger" : "secondary"}
          >
            {connected ? "已连接" : state === "connecting" ? "连接中" : state === "error" ? "未连接" : "待连接"}
          </Badge>
          <code className="hidden truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:block">
            {origin} / maim_message
          </code>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button className="size-7" onClick={() => void connect()} size="icon" title="重连" variant="outline">
            {state === "connecting" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
          <Button className="h-7 px-2 text-[11px]" onClick={() => setSettingsOpen(true)} size="sm" variant="secondary">
            <Settings />
            设置
          </Button>
        </div>
      </div>

      {error ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/15 px-4 py-2 text-[12px]">
          <CircleAlert className="size-3.5 text-warning" />
          <span className="min-w-0 flex-1 truncate">{error}</span>
        </div>
      ) : null}

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-4xl flex-col gap-3">
          {messages.length === 0 ? (
            <div className="grid min-h-72 place-items-center rounded-lg border border-dashed border-border bg-card/60 p-6 text-center">
              <div>
                <MessageSquare className="mx-auto size-8 text-primary" />
                <p className="mt-3 text-sm font-medium">和 MaiBot 本地对话</p>
                <p className="mt-1 text-xs text-muted-foreground">启动 MaiBot Core 后通过本地适配器发送消息。</p>
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <div
                className={cn("flex gap-2", message.role === "user" ? "justify-end" : "justify-start")}
                key={message.id}
              >
                {message.role !== "user" ? (
                  <span className="mt-1 grid size-8 shrink-0 place-items-center overflow-hidden rounded-md bg-primary/10 text-primary">
                    {message.role === "bot" && botAvatar ? (
                      <img alt="" className="size-full object-cover" src={botAvatar} />
                    ) : message.role === "bot" ? (
                      <Bot className="size-4" />
                    ) : (
                      <CircleAlert className="size-3.5" />
                    )}
                  </span>
                ) : null}
                <div
                  className={cn(
                    "max-w-[78%] rounded-lg border px-3 py-2 text-sm leading-relaxed",
                    message.role === "user"
                      ? "border-primary bg-primary text-primary-foreground"
                      : message.role === "error"
                        ? "border-destructive/30 bg-destructive/10 text-destructive"
                        : message.role === "system"
                          ? "border-border bg-muted/45 text-muted-foreground"
                          : "border-border bg-card text-foreground",
                  )}
                >
                  {message.sender ? <p className="mb-1 text-[11px] opacity-70">{message.sender}</p> : null}
                  {message.content ? <p className="whitespace-pre-wrap break-words">{message.content}</p> : null}
                  {message.images?.length ? (
                    <div className={cn("grid gap-2", message.content ? "mt-2" : "")}>
                      {message.images.map((image, index) => (
                        <img
                          alt={image.name ?? "图片"}
                          className="max-h-72 max-w-full rounded-md border border-black/10 object-contain"
                          key={`${message.id}-image-${index}`}
                          src={attachmentDataUrl(image)}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
                {message.role === "user" ? (
                  <span className="mt-1 grid size-8 shrink-0 place-items-center overflow-hidden rounded-md bg-secondary text-secondary-foreground">
                    {userAvatar ? <img alt="" className="size-full object-cover" src={userAvatar} /> : <UserRound className="size-4" />}
                  </span>
                ) : null}
              </div>
            ))
          )}
          {isTyping ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              MaiBot 正在思考
            </div>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 border-t border-border bg-card px-4 py-3">
        <div className="mx-auto flex max-w-4xl flex-col gap-2">
          {pendingImages.length ? (
            <div className="flex flex-wrap gap-2">
              {pendingImages.map((image, index) => (
                <div className="group relative h-16 w-16 overflow-hidden rounded-md border border-border bg-muted" key={`${image.name}-${index}`}>
                  <img alt={image.name ?? "图片"} className="size-full object-cover" src={attachmentDataUrl(image)} />
                  <button
                    className="absolute right-1 top-1 grid size-5 place-items-center rounded bg-background/85 text-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => setPendingImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    title="移除图片"
                    type="button"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-2">
            <Button disabled={!connected} onClick={() => imageInputRef.current?.click()} size="icon" title="发送图片" variant="outline">
              <ImageIcon />
            </Button>
            <input
              accept="image/*"
              className="hidden"
              multiple
              onChange={(event) => {
                void addImages(event.target.files);
                event.target.value = "";
              }}
              ref={imageInputRef}
              type="file"
            />
            <textarea
              className="min-h-10 max-h-32 min-w-0 flex-1 resize-none rounded-md border border-input bg-card px-3 py-2 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!connected}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              placeholder={connected ? "输入消息，Enter 发送，Shift+Enter 换行" : "等待本地适配器连接"}
              value={draft}
            />
            <Button disabled={!canSend} onClick={() => void sendMessage()}>
              <Send />
              发送
            </Button>
          </div>
        </div>
      </div>
      </section>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent size="md">
        <DialogHeader
          description="设置本地聊天的显示名称、头像和 maim_message 连接端口。"
          icon={<Settings className="size-4" />}
          title="随便聊聊设置"
          tone="primary"
        />
        <DialogBody className="space-y-4">
          <div className="rounded-lg border border-border bg-background p-3">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <UserRound className="size-4 text-primary" />
              本地用户
            </div>
            <div className="flex items-center gap-3">
              <AvatarButton
                avatar={userAvatar}
                fallback={<UserRound className="size-4" />}
                icon={<UserRound />}
                onPick={(file) => void pickAvatar(file, "user")}
                title="设置用户头像"
              />
              <label className="grid min-w-0 flex-1 gap-1.5 text-xs font-medium text-muted-foreground">
                <span>本地用户名</span>
                <Input
                  className="h-9 text-sm text-foreground"
                  onChange={(event) => setUserName(event.target.value)}
                  value={userName}
                />
              </label>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background p-3">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <Bot className="size-4 text-primary" />
              Bot
            </div>
            <div className="flex items-center gap-3">
              <AvatarButton
                avatar={botAvatar}
                fallback={<Bot className="size-4" />}
                icon={<Bot />}
                onPick={(file) => void pickAvatar(file, "bot")}
                title="设置 Bot 头像"
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-muted-foreground">Bot 头像</p>
                <p className="mt-1 text-xs text-muted-foreground">用于随便聊聊中的 MaiBot 消息头像。</p>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background p-3">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <MessageSquare className="size-4 text-primary" />
              连接
            </div>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              <span>maim_message 端口</span>
              <Input
                className="h-9 font-mono text-sm text-foreground"
                inputMode="numeric"
                onChange={(event) => setAdapterPort(event.target.value.replace(/\D/gu, "").slice(0, 5))}
                value={adapterPort}
              />
            </label>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setSettingsOpen(false)} size="sm" variant="ghost">
            关闭
          </Button>
          <Button
            onClick={() => {
              setSettingsOpen(false);
              void connect();
            }}
            size="sm"
          >
            {state === "connecting" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            重连
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>
    </>
  );
}
