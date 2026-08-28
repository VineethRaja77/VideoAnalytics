import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: { "@shared": path.resolve(root, "shared") },
  },
});
