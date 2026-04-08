import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(rootDir),
      "server-only": path.resolve(rootDir, "tests/server-only-stub.ts")
    }
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    globals: true
  }
});
