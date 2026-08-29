import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@mistake-book/shared": path.resolve(__dirname, "../packages/shared/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: true,
  },
});
