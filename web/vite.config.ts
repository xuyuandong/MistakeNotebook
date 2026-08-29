import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "学生错题本",
        short_name: "错题本",
        description: "录入错题 → AI 分析 → 复习 → 针对性练习",
        lang: "zh-CN",
        theme_color: "#757ef4",
        icons: [
          { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@mistake-book/shared": path.resolve(__dirname, "../packages/shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
