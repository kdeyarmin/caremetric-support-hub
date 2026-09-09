import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { validateBuildRuntimeConfig } from "./src/lib/runtimeConfig.ts";

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    validateBuildRuntimeConfig(
      loadEnv(mode, process.cwd(), "VITE_"),
      process.env.SUPPORT_HUB_ALLOW_DEMO_BUILD === "true",
    );
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
      coverage: {
        reporter: ["text", "json", "html"],
      },
    },
  };
});
