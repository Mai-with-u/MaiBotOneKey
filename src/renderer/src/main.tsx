import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootstrapTheme } from "./lib/use-theme";
import "./styles/globals.css";

bootstrapTheme();

function renderBootstrapError(error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const root = document.getElementById("root");
  if (!root) {
    return;
  }

  root.innerHTML = `
    <main style="height:100vh;display:grid;place-items:center;background:#f4f7f1;color:#1f2a20;font-family:system-ui,sans-serif;padding:24px;">
      <section style="max-width:560px;width:100%;border:1px solid #d9ded4;border-radius:12px;background:white;padding:24px;box-shadow:0 18px 50px rgb(0 0 0 / 0.12);">
        <h1 style="margin:0 0 8px;font-size:18px;">MaiBot OneKey 界面加载失败</h1>
        <p style="margin:0 0 16px;color:#5f695e;font-size:13px;line-height:1.7;">渲染入口发生错误，下面是错误信息。</p>
        <pre style="max-height:300px;overflow:auto;margin:0;padding:12px;border-radius:8px;background:#eef2ea;font-size:12px;line-height:1.6;white-space:pre-wrap;">${message.replace(/[&<>"']/g, (char) => {
          const entities: Record<string, string> = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          };
          return entities[char] ?? char;
        })}</pre>
      </section>
    </main>
  `;
}

window.addEventListener("error", (event) => {
  renderBootstrapError(event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  renderBootstrapError(event.reason);
});

try {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (error) {
  renderBootstrapError(error);
}
