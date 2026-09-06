const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";

export const config = {
  supabaseUrl,
  supabasePublishableKey,
  helpBaseUrl: import.meta.env.VITE_HELP_BASE_URL?.trim() || "https://help.caremetric.ai",
  demoMode:
    import.meta.env.VITE_DEMO_MODE === "true" ||
    !supabaseUrl ||
    !supabasePublishableKey,
};
