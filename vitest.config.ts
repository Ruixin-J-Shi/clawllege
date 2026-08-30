import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(root, "src") },
  },
  test: {
    environment: "node",
    // forks: PGlite (WASM) is not reliable across worker threads
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
