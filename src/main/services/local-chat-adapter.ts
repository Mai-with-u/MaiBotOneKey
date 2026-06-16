import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import type {
  LocalChatConnectionState,
  LocalChatConnectRequest,
  LocalChatEvent,
  LocalChatFileAttachment,
  LocalChatImageAttachment,
  LocalChatMessageEvent,
  LocalChatMessageQuote,
  LocalChatPlannerToolArgument,
  LocalChatPlannerToolCall,
  LocalChatSendRequest,
  LocalChatVoiceAttachment,
  RuntimePaths,
} from "../../shared/contracts";
import type { InitManager } from "./init-manager";

const DEFAULT_USER_ID = "onekey-local-user";
const DEFAULT_USER_NAME = "本地用户";
const MESSAGE_HISTORY_LIMIT = 120;
const DEFAULT_SESSION_ID = "desktop-simple-chat";
const WS_REQUEST_TIMEOUT_MS = 8_000;
const REPLY_MESSAGE_PREFIX = /^\s*\[回复消息\]\s*/u;

interface LocalChatSessionOptions {
  sessionId: string;
  userId: string;
  userName: string;
}

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

function normalizeSessionId(value: unknown): string {
  return asString(value) ?? DEFAULT_SESSION_ID;
}

function normalizeUserId(value: unknown): string {
  return asString(value) ?? DEFAULT_USER_ID;
}

function normalizeUserName(value: unknown): string {
  return asString(value) ?? DEFAULT_USER_NAME;
}

function webuiUserId(userId: string): string {
  return userId.startsWith("webui_user_") ? userId : `webui_user_${userId}`;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function dataUrlMimeType(dataUrl: string, fallback: string): string {
  const match = /^data:([^;,]+)[;,]/iu.exec(dataUrl);
  return match?.[1] ?? fallback;
}

function normalizeBase64Text(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) {
    return undefined;
  }
  const compact = text.replace(/\s+/gu, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(compact, "base64");
    if (decoded.length === 0) {
      return undefined;
    }
    return compact;
  } catch {
    return undefined;
  }
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

function emojiPlaceholder(emojis: LocalChatImageAttachment[]): string {
  if (emojis.length === 0) {
    return "";
  }
  return emojis.length === 1 ? "[表情]" : `[表情 x${emojis.length}]`;
}

function filePlaceholder(files: LocalChatFileAttachment[]): string {
  return files.map((file) => `[文件] ${file.name}`).join("\n");
}

function voicePlaceholder(voices: LocalChatVoiceAttachment[]): string {
  if (voices.length === 0) {
    return "";
  }
  return voices.length === 1 ? "[语音]" : `[语音 x${voices.length}]`;
}

function imagePayload(images: LocalChatImageAttachment[]): Record<string, string | number>[] {
  return images.map((image) => ({
    name: image.name ?? "",
    mime_type: image.mimeType,
    base64: image.base64.trim(),
    data_url: image.dataUrl ?? `data:${image.mimeType};base64,${image.base64.trim()}`,
    size: image.size ?? 0,
  }));
}

function imageAttachments(value: unknown): LocalChatImageAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record) {
      return [];
    }
    const mimeType = asString(record.mimeType) ?? asString(record.mime_type) ?? "image/png";
    const dataUrl = asString(record.dataUrl) ?? asString(record.data_url);
    let base64 = asString(record.base64) ?? "";
    if (!base64 && dataUrl?.startsWith("data:image/") && dataUrl.includes(",")) {
      base64 = dataUrl.split(",", 2)[1]?.trim() ?? "";
    }
    if (!base64 || !mimeType.startsWith("image/")) {
      return [];
    }
    return [{
      name: asString(record.name),
      mimeType,
      base64,
      dataUrl: dataUrl ?? `data:${mimeType};base64,${base64}`,
      size: asNumber(record.size),
    }];
  });
}

function voicePayload(voices: LocalChatVoiceAttachment[]): Record<string, string | number>[] {
  return voices.map((voice) => ({
    name: voice.name ?? "",
    mime_type: voice.mimeType,
    base64: voice.base64.trim(),
    data_url: voice.dataUrl ?? `data:${voice.mimeType};base64,${voice.base64.trim()}`,
    size: voice.size ?? 0,
  }));
}

function voiceAttachments(value: unknown): LocalChatVoiceAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record) {
      return [];
    }
    const mimeType = asString(record.mimeType) ?? asString(record.mime_type) ?? "audio/mpeg";
    const dataUrl = asString(record.dataUrl) ?? asString(record.data_url);
    let base64 = asString(record.base64) ?? "";
    if (!base64 && dataUrl?.startsWith("data:audio/") && dataUrl.includes(",")) {
      base64 = dataUrl.split(",", 2)[1]?.trim() ?? "";
    }
    if (!base64 || !mimeType.startsWith("audio/")) {
      return [];
    }
    return [{
      name: asString(record.name),
      mimeType,
      base64,
      dataUrl: dataUrl ?? `data:${mimeType};base64,${base64}`,
      size: asNumber(record.size),
    }];
  });
}

function filePayload(files: LocalChatFileAttachment[]): Record<string, string | number>[] {
  return files.map((file) => ({
    name: file.name,
    mime_type: file.mimeType,
    base64: file.base64.trim(),
    size: file.size,
  }));
}

function fileAttachments(value: unknown): LocalChatFileAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record) {
      return [];
    }
    const name = asString(record.name) ?? asString(record.file_name) ?? asString(record.filename);
    const base64 = asString(record.base64) ?? "";
    const size = asNumber(record.size) ?? 0;
    if (!name || !base64) {
      return [];
    }
    return [{
      name,
      mimeType: asString(record.mimeType) ?? asString(record.mime_type) ?? "application/octet-stream",
      base64,
      size,
    }];
  });
}

interface RichSegmentContent {
  content: string;
  emojis: LocalChatImageAttachment[];
  files: LocalChatFileAttachment[];
  hasSegments: boolean;
  images: LocalChatImageAttachment[];
  voices: LocalChatVoiceAttachment[];
}

function uniqueImages(images: LocalChatImageAttachment[]): LocalChatImageAttachment[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    const key = image.dataUrl ?? `${image.mimeType}:${image.base64}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueFiles(files: LocalChatFileAttachment[]): LocalChatFileAttachment[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.name}:${file.size}:${file.base64}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueVoices(voices: LocalChatVoiceAttachment[]): LocalChatVoiceAttachment[] {
  const seen = new Set<string>();
  return voices.filter((voice) => {
    const key = voice.dataUrl ?? `${voice.mimeType}:${voice.base64}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function segmentText(segment: Record<string, unknown>): string {
  const data = segment.data;
  if (typeof data === "string") {
    return data;
  }
  const record = asRecord(data);
  return asString(record?.text) ?? asString(record?.content) ?? asString(record?.message) ?? "";
}

function segmentBinaryRecord(
  segment: Record<string, unknown>,
  fallbackMimeType: string,
): Record<string, unknown> | undefined {
  const data = segment.data;
  const dataRecord = asRecord(data);
  const mimeType = asString(segment.mimeType) ?? asString(segment.mime_type) ?? fallbackMimeType;

  if (dataRecord) {
    return {
      ...dataRecord,
      base64: dataRecord.base64
        ?? dataRecord.binary_data_base64
        ?? dataRecord.image_base64
        ?? dataRecord.emoji_base64
        ?? dataRecord.voice_base64,
      data_url: dataRecord.data_url ?? dataRecord.dataUrl,
      mime_type: dataRecord.mime_type ?? dataRecord.mimeType ?? mimeType,
      name: dataRecord.name ?? segment.name,
      size: dataRecord.size ?? segment.size,
    };
  }

  const directBase64 = normalizeBase64Text(
    segment.binary_data_base64
      ?? segment.image_base64
      ?? segment.emoji_base64
      ?? segment.voice_base64,
  );
  if (directBase64) {
    return {
      base64: directBase64,
      mime_type: mimeType,
      name: asString(segment.name),
      size: asNumber(segment.size),
    };
  }

  const dataText = asString(data);
  if (!dataText) {
    return undefined;
  }
  if (dataText.startsWith("data:") && dataText.includes(",")) {
    return {
      data_url: dataText,
      mime_type: dataUrlMimeType(dataText, mimeType),
      name: asString(segment.name),
      size: asNumber(segment.size),
    };
  }

  const base64 = normalizeBase64Text(dataText);
  if (!base64) {
    return undefined;
  }
  return {
    base64,
    mime_type: mimeType,
    name: asString(segment.name),
    size: asNumber(segment.size),
  };
}

function richSegmentContent(value: unknown): RichSegmentContent {
  const empty: RichSegmentContent = {
    content: "",
    emojis: [],
    files: [],
    hasSegments: false,
    images: [],
    voices: [],
  };
  if (!Array.isArray(value) || value.length === 0) {
    return empty;
  }

  const textParts: string[] = [];
  const images: LocalChatImageAttachment[] = [];
  const emojis: LocalChatImageAttachment[] = [];
  const files: LocalChatFileAttachment[] = [];
  const voices: LocalChatVoiceAttachment[] = [];

  for (const item of value) {
    const segment = asRecord(item);
    const type = asString(segment?.type)?.toLowerCase();
    if (!segment || !type) {
      continue;
    }

    if (type === "text") {
      const text = segmentText(segment);
      if (text) {
        textParts.push(text);
      }
      continue;
    }

    if (type === "image") {
      const image = segmentBinaryRecord(segment, "image/png");
      images.push(...imageAttachments(image ? [image] : []));
      continue;
    }

    if (type === "emoji" || type === "face") {
      const emoji = segmentBinaryRecord(segment, "image/gif");
      emojis.push(...imageAttachments(emoji ? [emoji] : []));
      continue;
    }

    if (type === "voice") {
      const voice = segmentBinaryRecord(segment, "audio/wav");
      voices.push(...voiceAttachments(voice ? [voice] : []));
      continue;
    }

    if (type === "file") {
      const dataRecord = asRecord(segment.data);
      files.push(...fileAttachments(dataRecord ? [{
        ...dataRecord,
        mime_type: dataRecord.mime_type ?? dataRecord.mimeType ?? segment.mime_type ?? segment.mimeType,
        name: dataRecord.name ?? segment.name,
        size: dataRecord.size ?? segment.size,
      }] : []));
      continue;
    }

    if (type === "at") {
      const record = asRecord(segment.data);
      const name = asString(record?.target_user_nickname)
        ?? asString(record?.target_user_cardname)
        ?? asString(record?.target_user_id);
      if (name) {
        textParts.push(`@${name}`);
      }
    }
  }

  const hasParsedSegments = textParts.length > 0
    || images.length > 0
    || emojis.length > 0
    || files.length > 0
    || voices.length > 0;

  return {
    content: textParts.join("").trim(),
    emojis: uniqueImages(emojis),
    files: uniqueFiles(files),
    hasSegments: hasParsedSegments,
    images: uniqueImages(images),
    voices: uniqueVoices(voices),
  };
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
  const rich = richSegmentContent(message.segments ?? message.message_segments);
  const rawContent = rich.hasSegments ? rich.content : asString(message.content);
  const images = uniqueImages([...imageAttachments(message.images), ...rich.images]);
  const emojis = uniqueImages([...imageAttachments(message.emojis), ...rich.emojis]);
  const files = uniqueFiles([...fileAttachments(message.files), ...rich.files]);
  const voices = uniqueVoices([...voiceAttachments(message.voices), ...rich.voices]);
  const fallbackContent = [imagePlaceholder(images), emojiPlaceholder(emojis), voicePlaceholder(voices), filePlaceholder(files)]
    .filter(Boolean)
    .join("\n");
  const displayContent = rich.hasSegments ? rich.content : (rawContent ?? fallbackContent);
  if (!displayContent && !fallbackContent) {
    return undefined;
  }

  const parsed = splitReplyMessage(displayContent);
  const type = asString(message.type);
  const isBot = message.is_bot === true || type === "bot";
  return {
    id: asString(message.id) ?? `history-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: isBot ? "bot" : "user",
    content: parsed.content,
    timestamp: normalizeTimestamp(message.timestamp),
    sender: asString(message.sender_name) ?? (isBot ? "MaiBot" : DEFAULT_USER_NAME),
    images,
    emojis,
    files,
    voices,
    quote: quoteFromRecord(message),
  };
}

export class LocalChatAdapter extends EventEmitter {
  private socket: WebSocket | null = null;
  private state: LocalChatConnectionState = "idle";
  private currentUrl = "";
  private connectingPromise: Promise<void> | null = null;
  private activeSession: LocalChatSessionOptions = {
    sessionId: DEFAULT_SESSION_ID,
    userId: DEFAULT_USER_ID,
    userName: DEFAULT_USER_NAME,
  };
  private messagesBySession = new Map<string, LocalChatMessageEvent[]>();
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private lastUserName = DEFAULT_USER_NAME;
  private runtimeSessionIds = new Map<string, string>();
  private monitorSessionId: string | null = null;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly initManager: InitManager,
  ) {
    super();
  }

  getState(): LocalChatConnectionState {
    return this.state;
  }

  listMessages(request?: LocalChatConnectRequest): LocalChatMessageEvent[] {
    const sessionId = normalizeSessionId(request?.sessionId);
    return [...(this.messagesBySession.get(sessionId) ?? [])];
  }

  async connect(request?: LocalChatConnectRequest): Promise<LocalChatConnectionState> {
    const session = this.resolveSessionOptions(request);
    this.activeSession = session;
    if (this.isSocketOpen()) {
      await this.initializeSession(session);
      return this.state;
    }
    if (this.connectingPromise) {
      await this.connectingPromise;
      if (this.isSocketOpen()) {
        await this.initializeSession(session);
      }
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
    this.runtimeSessionIds.clear();
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
    const session = this.resolveSessionOptions(request);
    await this.connect(session);
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("简单聊聊未连接");
    }

    const content = request.content.trim();
    const images = (request.images ?? []).filter((image) => image.base64.trim() && image.mimeType.startsWith("image/"));
    const emojis = (request.emojis ?? []).filter((emoji) => emoji.base64.trim() && emoji.mimeType.startsWith("image/"));
    const files = (request.files ?? []).filter((file) => file.base64.trim() && file.name.trim());
    const voices = (request.voices ?? []).filter((voice) => voice.base64.trim() && voice.mimeType.startsWith("audio/"));
    if (!content && images.length === 0 && emojis.length === 0 && files.length === 0 && voices.length === 0) {
      throw new Error("消息内容为空");
    }

    const displayContent = [content, imagePlaceholder(images), emojiPlaceholder(emojis), voicePlaceholder(voices), filePlaceholder(files)]
      .filter(Boolean)
      .join("\n");
    this.lastUserName = session.userName;
    const message: LocalChatMessageEvent = {
      id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      sessionId: session.sessionId,
      role: "user",
      content: displayContent,
      timestamp: Date.now(),
      sender: this.lastUserName,
      images,
      emojis,
      files,
      voices,
    };

    await this.sendRequest({
      op: "call",
      domain: "chat",
      method: "message.send",
      session: session.sessionId,
      data: {
        content,
        images: imagePayload(images),
        emojis: imagePayload(emojis),
        files: filePayload(files),
        voices: voicePayload(voices),
        user_name: session.userName,
      },
    });
    this.emitMessage(message, session.sessionId);
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

  private resolveSessionOptions(request?: Partial<LocalChatConnectRequest & LocalChatSendRequest>): LocalChatSessionOptions {
    return {
      sessionId: normalizeSessionId(request?.sessionId),
      userId: normalizeUserId(request?.userId),
      userName: normalizeUserName(request?.userName ?? this.lastUserName),
    };
  }

  private isSocketOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
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
        void this.initializeSession(this.activeSession).then(() => finish()).catch(finish);
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

  private async initializeSession(session: LocalChatSessionOptions = this.activeSession): Promise<void> {
    this.activeSession = session;
    this.monitorSessionId = null;
    const response = asRecord(await this.sendRequest({
      op: "call",
      domain: "chat",
      method: "session.open",
      session: session.sessionId,
      data: {
        user_id: session.userId,
        user_name: session.userName,
        platform: "webui",
        restore: true,
      },
    }));
    const runtimeSessionId = asString(response?.session_id);
    if (runtimeSessionId) {
      this.runtimeSessionIds.set(session.sessionId, runtimeSessionId);
    }
    await this.sendRequest({
      op: "subscribe",
      domain: "maisaka_monitor",
      topic: "main",
    });
  }

  private async readWebUiOrigin(): Promise<string> {
    return this.initManager.readMaiBotWebUiEndpointSync().url;
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

    const eventSessionId = asString(event.session);
    if (domain === "chat" && eventSessionId) {
      this.handleChatEvent(eventName, data, eventSessionId);
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
    if ([...this.runtimeSessionIds.values()].includes(sessionId) || this.monitorSessionId === sessionId) {
      return true;
    }

    const platform = asString(data.platform);
    const userId = asString(data.user_id);
    const groupId = asString(data.group_id);
    const isGroupChat = data.is_group_chat === true;
    if (platform === "webui" && userId === webuiUserId(this.activeSession.userId) && !isGroupChat && !groupId) {
      this.monitorSessionId = sessionId;
      return true;
    }

    return false;
  }

  private handleChatEvent(eventName: string, data: Record<string, unknown>, sessionId: string): void {
    if (eventName === "typing" || eventName === "pong" || eventName === "virtual_identity_set") {
      return;
    }

    if (eventName === "history") {
      const history = Array.isArray(data.messages) ? data.messages : [];
      for (const item of history) {
        const message = historyMessageToLocal(asRecord(item) ?? {});
        if (message) {
          this.emitMessage({ ...message, sessionId }, sessionId);
        }
      }
      return;
    }

    const rich = richSegmentContent(data.segments ?? data.message_segments);
    const images = uniqueImages([...imageAttachments(data.images), ...rich.images]);
    const emojis = uniqueImages([...imageAttachments(data.emojis), ...rich.emojis]);
    const files = uniqueFiles([...fileAttachments(data.files), ...rich.files]);
    const voices = uniqueVoices([...voiceAttachments(data.voices), ...rich.voices]);
    const rawContent = rich.hasSegments ? rich.content : asString(data.content);
    const fallbackContent = [imagePlaceholder(images), emojiPlaceholder(emojis), voicePlaceholder(voices), filePlaceholder(files)]
      .filter(Boolean)
      .join("\n");
    const displayContent = rich.hasSegments ? rich.content : (rawContent ?? fallbackContent);
    if (!displayContent && !fallbackContent) {
      return;
    }

    const sender = asRecord(data.sender);
    const isUser = eventName === "user_message" || sender?.is_bot === false;
    const role = eventName === "error" ? "error" : isUser ? "user" : eventName === "system" ? "system" : "bot";
    const parsed = splitReplyMessage(displayContent);
    const content = parsed.content;
    if (
      role === "user"
      && (this.messagesBySession.get(sessionId) ?? []).some((message) =>
        message.role === "user"
        && message.content === content
        && Date.now() - message.timestamp < 10_000
      )
    ) {
      return;
    }
    this.emitMessage({
      id: asString(data.message_id) ?? `${eventName}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      sessionId,
      role,
      content,
      timestamp: normalizeTimestamp(data.timestamp),
      sender: asString(sender?.name) ?? (role === "bot" ? "MaiBot" : undefined),
      images,
      emojis,
      files,
      voices,
      quote: this.localQuoteForMessage(data, parsed.hasReplyPrefix, sessionId),
    }, sessionId);
  }

  private localQuoteForMessage(data: Record<string, unknown>, hasReplyPrefix: boolean, sessionId: string): LocalChatMessageQuote | undefined {
    const explicitQuote = quoteFromRecord(data);
    if (explicitQuote) {
      return explicitQuote;
    }
    if (!hasReplyPrefix) {
      return undefined;
    }
    const latestUserMessage = [...(this.messagesBySession.get(sessionId) ?? [])].reverse()
      .find((message) => message.role === "user" && message.content.trim());
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
      sessionId: this.activeSession.sessionId,
      role: "system",
      content,
      timestamp: normalizeTimestamp(data.timestamp),
      sender: "MaiSaka Planner",
      kind: "planner",
      final: eventName === "planner.finalized",
      plannerTools: plannerTools(data),
    }, this.activeSession.sessionId);
  }

  private emitMessage(message: LocalChatMessageEvent, sessionId = message.sessionId ?? this.activeSession.sessionId): void {
    const sessionMessages = this.messagesBySession.get(sessionId) ?? [];
    const eventMessage = { ...message, sessionId };
    const existingIndex = sessionMessages.findIndex((item) => item.id === eventMessage.id);
    let nextMessages: LocalChatMessageEvent[];
    if (existingIndex >= 0) {
      nextMessages = sessionMessages.map((item, index) => index === existingIndex ? { ...item, ...eventMessage } : item);
    } else {
      nextMessages = [...sessionMessages, eventMessage].slice(-MESSAGE_HISTORY_LIMIT);
    }
    this.messagesBySession.set(sessionId, nextMessages);
    this.emitEvent(eventMessage);
  }

  private setState(state: LocalChatConnectionState): void {
    this.state = state;
    this.emitEvent({ type: "state", state, sessionId: this.activeSession.sessionId, url: this.currentUrl });
  }

  private emitEvent(event: LocalChatEvent): void {
    this.emit("event", event);
  }
}
