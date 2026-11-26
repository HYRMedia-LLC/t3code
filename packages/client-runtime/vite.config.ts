import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Megabyte text scans take about a second alone and can pass 5s beside other suites in CI.
    testTimeout: 15_000,
    setupFiles: [
      "../shared/src/testing/longTempDir.ts",
      "../shared/src/testing/providerEnv.ts",
      "../shared/src/testing/gitEnv.ts",
    ],
  },
});
