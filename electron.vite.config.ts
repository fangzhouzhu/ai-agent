import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
  const isProd = mode === "production";

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      build: {
        sourcemap: !isProd,
        watch: {
          exclude: ["src/renderer/**", "out/**", "node_modules/**"],
        },
        rollupOptions: {
          input: {
            index: resolve(__dirname, "src/main/index.ts"),
          },
        },
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        sourcemap: !isProd,
        watch: {
          exclude: ["src/renderer/**", "out/**", "node_modules/**"],
        },
        rollupOptions: {
          input: {
            index: resolve(__dirname, "src/preload/index.ts"),
          },
        },
      },
    },
    renderer: {
      plugins: [react()],
      resolve: {
        alias: {
          "@renderer": resolve("src/renderer/src"),
        },
      },
    },
  };
});
