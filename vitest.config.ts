import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // "server-only" yalnızca React Server ortamında import edilebilir; testlerde boş modül
      "server-only": path.resolve(__dirname, "tests/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup.ts"],
    // Entegrasyon testleri aynı test veritabanını paylaşır
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
