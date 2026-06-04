import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, "electron/main/index.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, "electron/preload/index.ts") },
    },
  },
  renderer: {
    root: resolve(__dirname, "src"),
    plugins: [react()],
    resolve: {
      alias: {
        "@brandon/shared": resolve(__dirname, "../shared/src/types.ts"),
        "@": resolve(__dirname, "src"),
      },
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, "src/main/index.html"),
          overlay: resolve(__dirname, "src/overlay/index.html"),
        },
      },
    },
  },
});
