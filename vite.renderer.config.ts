import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Standalone Vite config used by `bun run dev:web`.
// Serves only the renderer without spawning Electron, so the UI can be
// previewed in a regular browser. `window.maibotDesktop` will be undefined,
// the components already guard against that.
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer/src"),
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
});
