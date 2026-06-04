import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Two HTML entry points — the main window and the overlay — mirror the
// electron-vite rollup setup. Tauri loads them as separate WebviewWindows.
// The dev server port (1420) is what tauri.conf.json's devUrl points at.
export default defineConfig({
  root: resolve(__dirname, "src"),
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "@brandon/shared": resolve(__dirname, "../shared/src/types.ts"),
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    // Tauri spawns the dev server; HMR over a fixed port keeps the webview in sync.
    host: false,
  },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    target: "es2021",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "src/main/index.html"),
        overlay: resolve(__dirname, "src/overlay/index.html"),
      },
    },
  },
});
