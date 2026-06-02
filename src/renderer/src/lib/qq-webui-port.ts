import type { QqBackend } from "@shared/contracts";

const QQ_WEBUI_PORT_STORAGE_PREFIX = "maibot.qqWebuiPort";

export const QQ_WEBUI_PORT_CHANGE_EVENT = "maibot-qq-webui-port-change";

export function qqWebuiPortStorageKey(backend: QqBackend): string {
  return `${QQ_WEBUI_PORT_STORAGE_PREFIX}.${backend}`;
}

export function defaultQqWebuiPort(backend: QqBackend): string {
  return backend === "snowluma" ? "5099" : "6099";
}

export function isValidPortText(value: string): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function normalizePortText(value: string, backend: QqBackend): string {
  return isValidPortText(value) ? String(Number(value)) : defaultQqWebuiPort(backend);
}

export function readQqWebuiPort(backend: QqBackend): string {
  try {
    return normalizePortText(localStorage.getItem(qqWebuiPortStorageKey(backend)) ?? "", backend);
  } catch {
    return defaultQqWebuiPort(backend);
  }
}

export function saveQqWebuiPort(backend: QqBackend, value: string): string {
  const port = normalizePortText(value, backend);
  try {
    localStorage.setItem(qqWebuiPortStorageKey(backend), port);
    window.dispatchEvent(new CustomEvent(QQ_WEBUI_PORT_CHANGE_EVENT, { detail: { backend, port } }));
  } catch {
    // Local storage may be unavailable in isolated previews.
  }
  return port;
}
