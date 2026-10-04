import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: "../../dist/web",
      emptyOutDir: true,
      chunkSizeWarningLimit: 1500,
    },
    server: {
      proxy: {
        "/api": {
          target: env.API_PROXY_TARGET || "http://localhost:3001",
          changeOrigin: false,
        },
      },
    },
  };
});
