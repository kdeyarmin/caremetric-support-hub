import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { validateBuildRuntimeConfig } from "./src/lib/runtimeConfig.ts";
import { verifyBackendContract } from "./src/lib/backendContract.ts";

export default defineConfig(async ({ command, mode }) => {
  if (command === "build") {
    const config = validateBuildRuntimeConfig(
      loadEnv(mode, process.cwd(), "VITE_"),
      process.env.SUPPORT_HUB_ALLOW_DEMO_BUILD === "true",
    );
    if (!config.demoMode) {
      await verifyBackendContract(config.supabaseUrl, config.supabasePublishableKey);
    }
  }

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 4173,
    },
    preview: {
      host: "0.0.0.0",
      port: 4173,
    },
    test: {
      environment: "node",
      // Real password hashing and DOM-heavy admin flows can exceed five seconds on shared runners.
      testTimeout: 15_000,
      coverage: {
        reporter: ["text", "json", "html"],
      },
    },
  };
});
