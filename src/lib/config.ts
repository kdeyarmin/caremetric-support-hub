import { resolveRuntimeConfig } from "./runtimeConfig";

export const config = resolveRuntimeConfig(
  {
    VITE_DEMO_MODE: import.meta.env.VITE_DEMO_MODE,
    VITE_HELP_BASE_URL: import.meta.env.VITE_HELP_BASE_URL,
    VITE_PENNTRAIN_BASE_URL: import.meta.env.VITE_PENNTRAIN_BASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  },
  typeof window === "undefined" ? undefined : window.location.origin,
);
