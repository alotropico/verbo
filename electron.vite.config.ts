import { resolve } from "path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "browser-runtime": resolve("browser-runtime/src/main.ts"),
          "application-discovery-worker": resolve(
            "src/main/software/application-discovery-worker.ts",
          ),
        },
      },
    },
  },
  preload: {
    build: {
      // Sandboxed preload cannot require node_modules; bundle dependencies.
      externalizeDeps: false,
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [react()],
    server: {
      port: 5273,
    },
  },
});
