import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import type {
  PtyInputRequest,
  PtyResizeRequest,
  PtySessionSnapshot,
  PtyStartRequest,
  PtyStopRequest,
} from "../../shared/contracts";
import { PtySessionManager } from "../pty/pty-session-manager";

interface RegisterPtyIpcOptions {
  manager: PtySessionManager;
  getMainWindow: () => BrowserWindow | null;
}

function isMissingSession(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("PTY session not found:");
}

export function registerPtyIpc({ manager, getMainWindow }: RegisterPtyIpcOptions): void {
  const sendToRenderer = (channel: string, payload: unknown): void => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      return;
    }

    window.webContents.send(channel, payload);
  };

  manager.on("data", (event) => sendToRenderer("pty:data", event));
  manager.on("exit", (event) => sendToRenderer("pty:exit", event));
  manager.on("error", (event) => sendToRenderer("pty:error", event));
  manager.on("snapshot", (snapshot) => sendToRenderer("pty:snapshot", snapshot));

  ipcMain.handle("pty:start", (_event, request: PtyStartRequest): PtySessionSnapshot => {
    return manager.start(request);
  });

  ipcMain.handle("pty:input", (_event, request: PtyInputRequest): void => {
    manager.input(request);
  });

  ipcMain.handle("pty:resize", (_event, request: PtyResizeRequest): void => {
    try {
      manager.resize(request);
    } catch (error) {
      if (!isMissingSession(error)) {
        throw error;
      }
    }
  });

  ipcMain.handle("pty:stop", (_event, request: PtyStopRequest): void => {
    manager.stop(request);
  });

  ipcMain.handle("pty:kill", (_event, sessionId: string): void => {
    manager.kill(sessionId);
  });

  ipcMain.handle("pty:close", (_event, sessionId: string): void => {
    manager.close(sessionId);
  });

  ipcMain.handle("pty:clear", (_event, sessionId: string): void => {
    manager.clear(sessionId);
  });

  ipcMain.handle("pty:list", (): PtySessionSnapshot[] => {
    return manager.list();
  });

  ipcMain.handle("pty:getBuffer", (_event, sessionId: string): string => {
    try {
      return manager.getBuffer(sessionId);
    } catch (error) {
      if (!isMissingSession(error)) {
        throw error;
      }
      return "";
    }
  });
}
