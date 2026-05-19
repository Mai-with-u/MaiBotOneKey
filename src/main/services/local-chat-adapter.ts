import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import type {
  LocalChatConnectionState,
  LocalChatConnectRequest,
  LocalChatEvent,
  LocalChatImageAttachment,
  LocalChatMessageEvent,
  LocalChatMessageQuote,
  LocalChatPlannerToolArgument,
  LocalChatPlannerToolCall,
  LocalChatSendRequest,
  RuntimePaths,
} from "../../shared/contracts";

const DEFAULT_WEBUI_ORIGIN = "http://127.0.0.1:8001";
const DEFAULT_USER_ID = "onekey-local-user";
const DEFAULT_WEBUI_USER_ID = `webui_user_${DEFAULT_USER_ID}`;
const DEFAULT_USER_NAME = "本地用户";
const MESSAGE_HISTORY_LIMIT = 120;
const SESSION_ID = "desktop-simple-chat";
const WS_REQUEST_TIMEOUT_MS = 8_000;
const REPLY_MESSAGE_PREFIX = /^\s*\[回复消息\]\s*/u;

interface UnifiedWsEvent {
  op?: unknown;
  domain?: unknown;
  event?: unknown;
  session?: unknown;
  data?: unknown;
}

interface UnifiedWsResponse {
  op?: unknown;
  id?: unknown;
  ok?: unknown;
  data?: unknown;
  error?: unknown;
}

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (data: unknown) => void;
  timeout: NodeJS.Timeout;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseSocketPayload(data: WebSocket.RawData): unknown | undefined {
  try {
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : data.toString();
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizeTimestamp(value: unknown): number {
  const timestamp = asNumber(value);
  if (!timestamp) {
    return Date.now();
  }
  return timestamp > 10_000_000_000 ? Math.round(timestamp) : Math.round(timestamp * 1000);
}

function imagePlaceholder(images: LocalChatImageAttachment[]): string {
  if (images.length === 0) {
    return "";
  }
  return images.length === 1 ? "[图片]" : `[图片 x${images.length}]`;
}

function plannerContent(data: Record<string, unknown>): string {
  const planner = asRecord(data.planner);
  const content = asString(data.content) ?? asString(planner?.content);
  return content ?? "";
}

function stringifyToolArguments(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stringifyToolValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseToolArguments(value: unknown): LocalChatPlannerToolArgument[] | undefined {
  let parsed = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [{ key: "参数", value: trimmed }];
    }
  }
  const record = asRecord(parsed);
  if (!record) {
    return parsed === undefined || parsed === null
      ? undefined
      : [{ key: "参数", value: stringifyToolValue(parsed) }];
  }
  const entries = Object.entries(record)
    .map(([key, entryValue]) => ({ key, value: stringifyToolValue(entryValue) }))
    .filter((entry) => entry.value.length > 0);
  return entries.length ? entries : undefined;
}

function plannerTools(data: Record<string, unknown>): LocalChatPlannerToolCall[] {
  const planner = asRecord(data.planner);
  const rawToolCalls = Array.isArray(data.tool_calls)
    ? data.tool_calls
    : Array.isArray(planner?.tool_calls)
      ? planner.tool_calls
      : [];
  const calls = rawToolCalls
    .map((item): LocalChatPlannerToolCall | undefined => {
      const record = asRecord(item);
      const name = asString(record?.name);
      if (!record || !name) {
        return undefined;
      }
      return {
        id: asString(record.id),
        name,
        arguments: parseToolArguments(record.arguments ?? record.arguments_raw),
        argumentsText: stringifyToolArguments(record.arguments ?? record.arguments_raw),
      };
    })
    .filter((item): item is LocalChatPlannerToolCall => Boolean(item));

  const rawResults = Array.isArray(data.tools) ? data.tools : [];
  for (const item of rawResults) {
    const record = asRecord(item);
    const name = asString(record?.tool_name);
    if (!record || !name) {
      continue;
    }
    const id = asString(record.tool_call_id);
    const existing = calls.find((call) => (id && call.id === id) || call.name === name);
    const result = {
      id,
      name,
      arguments: parseToolArguments(record.tool_args),
      argumentsText: stringifyToolArguments(record.tool_args),
      resultText: asString(record.summary) ?? stringifyToolArguments(record.detail),
      success: typeof record.success === "boolean" ? record.success : undefined,
      durationMs: asNumber(record.duration_ms),
    };
    if (existing) {
      Object.assign(existing, result);
    } else {
      calls.push(result);
    }
  }

  return calls;
}

function quoteFromRecord(record: Record<string, unknown> | undefined): LocalChatMessageQuote | undefined {
  if (!record) {
    return undefined;
  }
  const quoteRecord = asRecord(record.quote)
    ?? asRecord(record.reply)
    ?? asRecord(record.replied_message)
    ?? asRecord(record.quote_message)
    ?? asRecord(record.reference);
  const content = asString(quoteRecord?.content)
    ?? asString(quoteRecord?.text)
    ?? asString(quoteRecord?.message)
    ?? asString(record.quote_content)
    ?? asString(record.reply_content);
  if (!content) {
    return undefined;
  }
  const sender = asRecord(quoteRecord?.sender);
  return {
    messageId: asString(quoteRecord?.message_id) ?? asString(quoteRecord?.id) ?? asString(record.quote_message_id),
    sender: asString(sender?.name)
      ?? asString(quoteRecord?.sender_name)
      ?? asString(quoteRecord?.sender)
      ?? asString(record.quote_sender_name),
    content,
  };
}

function splitReplyMessage(content: string): { content: string; hasReplyPrefix: boolean } {
  if (!REPLY_MESSAGE_PREFIX.test(content)) {
    return { content, hasReplyPrefix: false };
  }
  return {
    content: content.replace(REPLY_MESSAGE_PREFIX, "").trim(),
    hasReplyPrefix: true,
  };
}

function historyMessageToLocal(message: Record<string, unknown>): LocalChatMessageEvent | undefined {
  const rawContent = asString(message.content);
  if (!rawContent) {
    return undefined;
  }

  const parsed = splitReplyMessage(rawContent);
  const type = asString(message.type);
  const isBot = message.is_bot === true || type === "bot";
  return {
    id: asString(message.id) ?? `history-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: isBot ? "bot" : "user",
    content: parsed.content,
    timestamp: normalizeTimestamp(message.timestamp),
    sender: asString(message.sender_name) ?? (isBot ? "MaiBot" : DEFAULT_USER_NAME),
    quote: quoteFromRecord(message),
  };
}

export class LocalChatAdapter extends EventEmitter {
  private socket: WebSocket | null = null;
  private state: LocalChatConnectionState = "idle";
  private currentUrl = "";
  private connectingPromise: Promise<void> | null = null;
  private messages: LocalChatMessageEvent[] = [];
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private lastUserName = DEFAULT_USER_NAME;
  private runtimeSessionId: string | null = null;
  private monitorSessionId: string | null = null;

  constructor(private readonly paths: RuntimePaths) {
    super();
  }

  getState(): LocalChatConnectionState {
    return this.state;
  }

  listMessages(): LocalChatMessageEvent[] {
    return [...this.messages];
  }

  async connect(_request?: LocalChatConnectRequest): Promise<LocalChatConnectionState> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return this.state;
    }
    if (this.connectingPromise) {
      await this.connectingPromise;
      return this.state;
    }

    this.connectingPromise = this.openSocket().finally(() => {
      this.connectingPromise = null;
    });
    await this.connectingPromise;
    return this.state;
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.runtimeSessionId = null;
    this.monitorSessionId = null;
    this.rejectPendingRequests(new Error("简单聊聊连接已关闭"));
    if (socket) {
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
      socket.terminate();
    }
    this.setState("idle");
  }

  async send(request: LocalChatSendRequest): Promise<LocalChatMessageEvent> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("简单聊聊未连接");
    }

    const content = request.content.trim();
    const images = (request.images ?? []).filter((image) => image.base64.trim() && image.mimeType.startsWith("image/"));
    if (!content && images.length === 0) {
      throw new Error("消息内容为空");
    }

    const displayContent = [content, imagePlaceholder(images)].filter(Boolean).join("\n");
    this.lastUserName = request.userName?.trim() || DEFAULT_USER_NAME;
    const message: LocalChatMessageEvent = {
      id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: "user",
      content: displayContent,
      timestamp: Date.now(),
      sender: this.lastUserName,
      images,
    };

    await this.sendRequest({
      op: "call",
      domain: "chat",
      method: "message.send",
      session: SESSION_ID,
      data: {
        content: displayContent,
        user_name: this.lastUserName,
      },
    });
    this.emitMessage(message);
    return message;
  }

  dispose(): void {
    this.disconnect();
    this.removeAllListeners();
  }

  onEvent(callback: (event: LocalChatEvent) => void): () => void {
    this.on("event", callback);
    return () => this.off("event", callback);
  }

  private async openSocket(): Promise<void> {
    const origin = await this.readWebUiOrigin();
    const token = await this.readWebUiToken();
    const wsOrigin = origin.replace(/^http/u, "ws").replace(/\/+$/u, "");
    this.currentUrl = `${wsOrigin}/api/webui/ws`;
    this.setState("connecting");

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.currentUrl, {
        headers: token ? { Cookie: `maibot_session=${encodeURIComponent(token)}` } : {},
      });
      let settled = false;
      const timeout = setTimeout(() => {
        finish(new Error(`连接 MaiBot 简单聊聊超时：${origin}`));
      }, WS_REQUEST_TIMEOUT_MS);

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (error) {
          socket.close();
          reject(error);
          return;
        }
        resolve();
      };

      socket.on("open", () => {
        this.socket = socket;
        this.setState("connected");
        void this.initializeSession().then(() => finish()).catch(finish);
      });
      socket.on("message", (data) => this.handleSocketMessage(data));
      socket.on("error", () => {
        this.setState("error");
        finish(new Error(`无法连接 MaiBot 简单聊聊：${origin}`));
      });
      socket.on("close", () => {
        this.rejectPendingRequests(new Error("简单聊聊连接已断开"));
        if (this.socket === socket) {
          this.socket = null;
          this.setState(this.state === "idle" ? "idle" : "error");
        }
      });
    });
  }

  private async initializeSession(): Promise<void> {
    this.monitorSessionId = null;
    const response = asRecord(await this.sendRequest({
      op: "call",
      domain: "chat",
      method: "session.open",
      session: SESSION_ID,
      data: {
        user_id: DEFAULT_USER_ID,
        user_name: this.lastUserName,
        platform: "webui",
        restore: true,
      },
    }));
    this.runtimeSessionId = asString(response?.session_id) ?? null;
    await this.sendRequest({
      op: "subscribe",
      domain: "maisaka_monitor",
      topic: "main",
    });
  }

  private async readWebUiOrigin(): Promise<string> {
    const candidates = [
      join(this.paths.maibotRoot, "data", "webui.json"),
      join(this.paths.bundledModulesRoot, "MaiBot", "data", "webui.json"),
    ];
    for (const configPath of candidates) {
      try {
        const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
        const port = asNumber(raw.webui_port) ?? asNumber(raw.port);
        if (port) {
          return `http://127.0.0.1:${port}`;
        }
      } catch {
        // Try the next known location.
      }
    }
    return DEFAULT_WEBUI_ORIGIN;
  }

  private async readWebUiToken(): Promise<string | null> {
    const candidates = [
      join(this.paths.maibotRoot, "data", "webui.json"),
      join(this.paths.bundledModulesRoot, "MaiBot", "data", "webui.json"),
    ];
    for (const configPath of candidates) {
      try {
        const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
        const token = asString(raw.access_token);
        if (token) {
          return token;
        }
      } catch {
        // Try the next known location.
      }
    }
    return null;
  }

  private sendRequest(payload: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("简单聊聊未连接"));
    }

    this.requestCounter += 1;
    const id = `onekey-${Date.now()}-${this.requestCounter}`;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error("简单聊聊插件请求超时"));
      }, WS_REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ ...payload, id }));
    });
  }

  private rejectPendingRequests(error: Error): void {
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(error);
    });
    this.pendingRequests.clear();
  }

  private handleSocketMessage(data: WebSocket.RawData): void {
    const payload = parseSocketPayload(data);
    const record = asRecord(payload);
    if (!record) {
      return;
    }

    if (record.op === "response") {
      this.handleResponse(record as UnifiedWsResponse);
      return;
    }
    if (record.op === "event") {
      this.handleEvent(record as UnifiedWsEvent);
    }
  }

  private handleResponse(response: UnifiedWsResponse): void {
    const id = asString(response.id);
    if (!id) {
      return;
    }
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(id);
    if (response.ok === true) {
      pending.resolve(response.data);
      return;
    }

    const error = asRecord(response.error);
    pending.reject(new Error(asString(error?.message) ?? "简单聊聊插件请求失败"));
  }

  private handleEvent(event: UnifiedWsEvent): void {
    const domain = asString(event.domain);
    const eventName = asString(event.event);
    const data = asRecord(event.data);
    if (!domain || !eventName || !data) {
      return;
    }

    if (domain === "chat" && event.session === SESSION_ID) {
      this.handleChatEvent(eventName, data);
      return;
    }
    if (domain === "maisaka_monitor" && this.isLocalPlannerEvent(data)) {
      this.handlePlannerEvent(eventName, data);
    }
  }

  private isLocalPlannerEvent(data: Record<string, unknown>): boolean {
    const sessionId = asString(data.session_id);
    if (!sessionId) {
      return false;
    }
    if (this.runtimeSessionId === sessionId || this.monitorSessionId === sessionId) {
      return true;
    }

    const platform = asString(data.platform);
    const userId = asString(data.user_id);
    const groupId = asString(data.group_id);
    const isGroupChat = data.is_group_chat === true;
    if (platform === "webui" && userId === DEFAULT_WEBUI_USER_ID && !isGroupChat && !groupId) {
      this.monitorSessionId = sessionId;
      return true;
    }

    return false;
  }

  private handleChatEvent(eventName: string, data: Record<string, unknown>): void {
    if (eventName === "typing" || eventName === "pong" || eventName === "virtual_identity_set") {
      return;
    }

    if (eventName === "history") {
      const history = Array.isArray(data.messages) ? data.messages : [];
      for (const item of history) {
        const message = historyMessageToLocal(asRecord(item) ?? {});
        if (message) {
          this.emitMessage(message);
        }
      }
      return;
    }

    const rawContent = asString(data.content);
    if (!rawContent) {
      return;
    }

    const sender = asRecord(data.sender);
    const isUser = eventName === "user_message" || sender?.is_bot === false;
    const role = eventName === "error" ? "error" : isUser ? "user" : eventName === "system" ? "system" : "bot";
    const parsed = splitReplyMessage(rawContent);
    const content = parsed.content;
    if (
      role === "user"
      && this.messages.some((message) =>
        message.role === "user"
        && message.content === content
        && Date.now() - message.timestamp < 10_000
      )
    ) {
      return;
    }
    this.emitMessage({
      id: asString(data.message_id) ?? `${eventName}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role,
      content,
      timestamp: normalizeTimestamp(data.timestamp),
      sender: asString(sender?.name) ?? (role === "bot" ? "MaiBot" : undefined),
      quote: this.localQuoteForMessage(data, parsed.hasReplyPrefix),
    });
  }

  private localQuoteForMessage(data: Record<string, unknown>, hasReplyPrefix: boolean): LocalChatMessageQuote | undefined {
    const explicitQuote = quoteFromRecord(data);
    if (explicitQuote) {
      return explicitQuote;
    }
    if (!hasReplyPrefix) {
      return undefined;
    }
    const latestUserMessage = [...this.messages].reverse().find((message) => message.role === "user" && message.content.trim());
    if (!latestUserMessage) {
      return undefined;
    }
    return {
      messageId: latestUserMessage.id,
      sender: latestUserMessage.sender,
      content: latestUserMessage.content,
    };
  }

  private handlePlannerEvent(eventName: string, data: Record<string, unknown>): void {
    if (eventName !== "planner.response" && eventName !== "planner.finalized") {
      return;
    }

    const content = plannerContent(data);
    if (!content) {
      return;
    }

    this.emitMessage({
      id: `planner-${asString(data.session_id) ?? "session"}-${asString(data.cycle_id) ?? Date.now().toString()}`,
      role: "system",
      content,
      timestamp: normalizeTimestamp(data.timestamp),
      sender: "MaiSaka Planner",
      kind: "planner",
      final: eventName === "planner.finalized",
      plannerTools: plannerTools(data),
    });
  }

  private emitMessage(message: LocalChatMessageEvent): void {
    const existingIndex = this.messages.findIndex((item) => item.id === message.id);
    if (existingIndex >= 0) {
      this.messages = this.messages.map((item, index) => index === existingIndex ? { ...item, ...message } : item);
    } else {
      this.messages = [...this.messages, message].slice(-MESSAGE_HISTORY_LIMIT);
    }
    this.emitEvent(message);
  }

  private setState(state: LocalChatConnectionState): void {
    this.state = state;
    this.emitEvent({ type: "state", state, url: this.currentUrl });
  }

  private emitEvent(event: LocalChatEvent): void {
    this.emit("event", event);
  }
}
