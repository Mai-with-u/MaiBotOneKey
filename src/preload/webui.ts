import { contextBridge, ipcRenderer } from "electron";

// The WebUI gets navigation only, never the host's process or protocol management APIs.
if (location.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)) {
  contextBridge.exposeInMainWorld("maibotDesktopHost", {
    openMessagePlatform: () => ipcRenderer.sendToHost("maibot:open-message-platform"),
    // The OneKey title bar shows the brand, versions and updates, so the WebUI hides its own copies.
    embedded: true,
    reportLayout: (layout: unknown) => {
      const value = layout as { sidebarWidth?: unknown; collapsed?: unknown; homeLocked?: unknown } | null;
      if (typeof value?.sidebarWidth !== "number") return;
      ipcRenderer.sendToHost("maibot:layout", {
        sidebarWidth: value.sidebarWidth,
        collapsed: value.collapsed === true,
        homeLocked: value.homeLocked === true,
      });
    },
    // The sidebar collapse key lives in the OneKey title bar; the WebUI applies what it sends.
    onSidebarCommand: (listener: (command: { collapsed: boolean }) => void) => {
      const handle = (_event: unknown, command: { collapsed?: unknown } | undefined) => {
        listener({ collapsed: command?.collapsed === true });
      };
      ipcRenderer.on("maibot:sidebar", handle);
      return () => {
        ipcRenderer.removeListener("maibot:sidebar", handle);
      };
    },
  });
}
