import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// 后端地址默认 127.0.0.1:9876；可用 VITE_BACKEND 覆盖（如 http://192.168.1.155:9876）
const backend = process.env.VITE_BACKEND || "http://127.0.0.1:9876";

export default defineConfig({
  base: "/console/",
  plugins: [vue()],
  server: {
    port: 5174,
    proxy: {
      "/observe": backend,
      "/agent": backend,
      "/console/api": backend,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
