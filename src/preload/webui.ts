import { contextBridge, ipcRenderer } from "electron";

// The WebUI gets navigation only, never the host's process or protocol management APIs.
if (location.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)) {
  contextBridge.exposeInMainWorld("maibotDesktopHost", {
    openMessagePlatform: () => ipcRenderer.sendToHost("maibot:open-message-platform"),
  });
}
