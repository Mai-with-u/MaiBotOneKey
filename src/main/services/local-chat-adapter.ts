import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import WebSocket from "ws";
import type {
  LocalChatConnectionState,
  LocalChatConnectRequest,
  LocalChatEvent,
  LocalChatImageAttachment,
  LocalChatMessageEvent,
  LocalChatSendRequest,
  RuntimePaths,
} from "../../shared/contracts";

const PLATFORM = "onekey-local-chat";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8000;
const DEFAULT_USER_ID = "onekey-local-user";
const DEFAULT_USER_NAME = "本地用户";

type LocalChatAdapterEventMap = {
  event: [LocalChatEvent];
};

interface MaimMessageConfig {
  host: string;
  port: number;
  token?: string;
}

interface MaimMessagePayload {
  content?: unknown;
  text?: unknown;
  message?: unknown;
  message_info?: {
    platform?: string;
    message_id?: string;
    time?: number;
    user_info?: Record<string, unknown>;
    [key: string]: unknown;
  };
  message_segment?: MaimSegment;
  message_segments?: unknown;
  segments?: unknown;
  raw_message?: unknown;
}

interface MaimSegment {
  type?: string;
  data?: unknown;
  content?: unknown;
  text?: unknown;
  segments?: unknown;
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

function normalizePort(value: number | undefined): number | undefined {
  if (!Number.isInteger(value)) {
    return undefined;
  }

  const port = value as number;
  return port >= 1 && port <= 65535 ? port : undefined;
}

function buildWsUrl(config: MaimMessageConfig): string {
  const url = new URL(`ws://${config.host}:${config.port}/ws`);
  return url.toString();
}

function extractTextFromSegment(segment: unknown): string {
  const record = asRecord(segment);
  if (!record) {
    return typeof segment === "string" ? segment : "";
  }

  const type = asString(record.type);
  const data = record.data;
  if (type === "text") {
    return typeof data === "string" ? data : asString(record.content) ?? asString(record.text) ?? "";
  }
  if (type === "seglist" && Array.isArray(data)) {
    return data.map(extractTextFromSegment).filter(Boolean).join("");
  }
  if (Array.isArray(record.segments)) {
    return record.segments.map(extractTextFromSegment).filter(Boolean).join("");
  }
  if (type === "image") {
    return "[图片]";
  }
  if (type === "emoji") {
    return "[表情]";
  }
  if (type === "voice") {
    return "[语音]";
  }
  return "";
}

function extractTextFromSegments(segments: unknown): string {
  return Array.isArray(segments) ? segments.map(extractTextFromSegment).filter(Boolean).join("") : "";
}

function imageFromData(data: string): LocalChatImageAttachment | undefined {
  const trimmed = data.trim();
  if (!trimmed) {
    return undefined;
  }

  const dataUrlMatch = trimmed.match(/^data:(image\/[^;]+);base64,(.+)$/u);
  if (dataUrlMatch) {
    return {
      mimeType: dataUrlMatch[1],
      base64: dataUrlMatch[2],
      dataUrl: trimmed,
    };
  }

  return {
    mimeType: "image/png",
    base64: trimmed,
    dataUrl: `data:image/png;base64,${trimmed}`,
  };
}

function extractImagesFromSegment(segment: unknown): LocalChatImageAttachment[] {
  const record = asRecord(segment);
  if (!record) {
    return [];
  }

  const type = asString(record.type);
  if (type === "image" && typeof record.data === "string") {
    const image = imageFromData(record.data);
    return image ? [image] : [];
  }
  if (type === "seglist" && Array.isArray(record.data)) {
    return record.data.flatMap(extractImagesFromSegment);
  }
  if (Array.isArray(record.segments)) {
    return record.segments.flatMap(extractImagesFromSegment);
  }
  return [];
}

function extractImagesFromSegments(segments: unknown): LocalChatImageAttachment[] {
  return Array.isArray(segments) ? segments.flatMap(extractImagesFromSegment) : [];
}

function extractTextFromPayload(payload: unknown): string {
  const record = asRecord(payload);
  if (!record) {
    return "";
  }

  const direct =
    asString(record.display_message)
    ?? asString(record.processed_plain_text)
    ?? asString(record.content)
    ?? asString(record.text)
    ?? asString(record.raw_message);
  if (direct) {
    return direct;
  }

  const nestedMessage = asRecord(record.message);
  const nestedDirect =
    asString(nestedMessage?.display_message)
    ?? asString(nestedMessage?.processed_plain_text)
    ?? asString(nestedMessage?.content)
    ?? asString(nestedMessage?.text)
    ?? asString(nestedMessage?.raw_message);
  if (nestedDirect) {
    return nestedDirect;
  }

  return (
    extractTextFromSegment(record.message_segment)
    || extractTextFromSegments(record.message_segments)
    || extractTextFromSegments(record.segments)
    || extractTextFromSegment(nestedMessage?.message_segment)
    || extractTextFromSegments(nestedMessage?.message_segments)
    || extractTextFromSegments(nestedMessage?.segments)
  );
}

function extractImagesFromPayload(payload: unknown): LocalChatImageAttachment[] {
  const record = asRecord(payload);
  if (!record) {
    return [];
  }

  const nestedMessage = asRecord(record.message);
  return [
    ...extractImagesFromSegment(record.message_segment),
    ...extractImagesFromSegments(record.message_segments),
    ...extractImagesFromSegments(record.segments),
    ...extractImagesFromSegment(nestedMessage?.message_segment),
    ...extractImagesFromSegments(nestedMessage?.message_segments),
    ...extractImagesFromSegments(nestedMessage?.segments),
  ];
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

export class LocalChatAdapter extends EventEmitter {
  private socket: WebSocket | null = null;
  private state: LocalChatConnectionState = "idle";
  private currentUrl = "";
  private connectingPromise: Promise<void> | null = null;

  constructor(private readonly paths: RuntimePaths) {
    super();
  }

  getState(): LocalChatConnectionState {
    return this.state;
  }

  async connect(request?: LocalChatConnectRequest): Promise<LocalChatConnectionState> {
    if (this.socket?.readyState === WebSocket.OPEN && !request?.port) {
      return this.state;
    }
    if (this.socket?.readyState === WebSocket.OPEN && request?.port && this.currentUrl.includes(`:${request.port}/`)) {
      return this.state;
    }
    if (request?.port) {
      this.disconnect();
    }
    if (this.connectingPromise) {
      await this.connectingPromise;
      return this.state;
    }

    this.connectingPromise = this.openSocket(request).finally(() => {
      this.connectingPromise = null;
    });
    await this.connectingPromise;
    return this.state;
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.close();
    }
    this.setState("idle");
  }

  async send(request: LocalChatSendRequest): Promise<LocalChatMessageEvent> {
    await this.connect({ port: request.port });
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("本地适配器未连接");
    }

    const content = request.content.trim();
    const images = (request.images ?? []).filter((image) => image.base64.trim() && image.mimeType.startsWith("image/"));
    if (!content && images.length === 0) {
      throw new Error("消息内容为空");
    }

    const message: LocalChatMessageEvent = {
      id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: "user",
      content,
      timestamp: Date.now(),
      sender: request.userName?.trim() || DEFAULT_USER_NAME,
      images,
    };
    socket.send(JSON.stringify(this.buildMessagePayload(message)));
    this.emitEvent(message);
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

  private async openSocket(request?: LocalChatConnectRequest): Promise<void> {
    const config = await this.readConfig(request);
    const url = buildWsUrl(config);
    this.currentUrl = url;
    this.setState("connecting");

    await new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = { platform: PLATFORM };
      if (config.token) {
        headers.authorization = config.token;
      }
      const socket = new WebSocket(url, { headers });
      let settled = false;
      const timeout = setTimeout(() => {
        finish(new Error(`连接本地适配器超时: ${url}`));
      }, 8_000);

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
        finish();
      });
      socket.on("message", (data) => this.handleSocketMessage(data));
      socket.on("error", () => {
        this.setState("error");
        finish(new Error(`无法连接本地适配器: ${url}`));
      });
      socket.on("close", () => {
        if (this.socket === socket) {
          this.socket = null;
          this.setState(this.state === "idle" ? "idle" : "error");
        }
      });
    });
  }

  private async readConfig(request?: LocalChatConnectRequest): Promise<MaimMessageConfig> {
    const portOverride = normalizePort(request?.port);
    const path = join(this.paths.maibotRoot, "config", "bot_config.toml");
    try {
      const parsed = parseToml(await readFile(path, "utf8")) as Record<string, unknown>;
      const maimMessage = asRecord(parsed.maim_message);
      const host = asString(maimMessage?.ws_server_host) ?? DEFAULT_HOST;
      const port = portOverride ?? asNumber(maimMessage?.ws_server_port) ?? DEFAULT_PORT;
      const tokens = Array.isArray(maimMessage?.auth_token) ? maimMessage.auth_token : [];
      const token = tokens.map(asString).find(Boolean);
      return { host: host === "0.0.0.0" ? DEFAULT_HOST : host, port, token };
    } catch {
      return { host: DEFAULT_HOST, port: portOverride ?? DEFAULT_PORT };
    }
  }

  private buildMessagePayload(message: LocalChatMessageEvent): MaimMessagePayload {
    const imageSegments = (message.images ?? []).map((image) => ({ type: "image", data: image.base64 }));
    const segments = [
      ...(message.content ? [{ type: "text", data: message.content }] : []),
      ...imageSegments,
    ];

    return {
      message_info: {
        platform: PLATFORM,
        message_id: message.id,
        time: message.timestamp / 1000,
        group_info: null,
        user_info: {
          platform: PLATFORM,
          user_id: DEFAULT_USER_ID,
          user_nickname: message.sender ?? DEFAULT_USER_NAME,
          user_cardname: message.sender ?? DEFAULT_USER_NAME,
        },
        format_info: {
          content_format: imageSegments.length > 0 ? ["text", "image"] : ["text"],
          accept_format: ["text", "image", "emoji"],
        },
        template_info: null,
        additional_config: {
          platform_io_target_user_id: DEFAULT_USER_ID,
        },
      },
      message_segment: {
        type: "seglist",
        data: segments,
      },
      raw_message: message.content,
    };
  }

  private handleSocketMessage(data: WebSocket.RawData): void {
    const payload = parseSocketPayload(data);
    if (!payload) {
      return;
    }

    const content = extractTextFromPayload(payload);
    const images = extractImagesFromPayload(payload);
    if (!content && images.length === 0) {
      return;
    }

    const record = asRecord(payload);
    const info = asRecord(record?.message_info) ?? asRecord(asRecord(record?.message)?.message_info);
    const userInfo = asRecord(info?.user_info) ?? asRecord(record?.sender);
    this.emitEvent({
      id: asString(info?.message_id) ?? `remote-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: "bot",
      content,
      timestamp: Math.round((asNumber(info?.time) ?? asNumber(record?.timestamp) ?? Date.now() / 1000) * 1000),
      sender: asString(userInfo?.user_nickname) ?? asString(userInfo?.name) ?? "MaiBot",
      images,
    });
  }

  private setState(state: LocalChatConnectionState): void {
    this.state = state;
    this.emitEvent({ type: "state", state, url: this.currentUrl });
  }

  private emitEvent(event: LocalChatEvent): void {
    this.emit("event", event);
  }
}
