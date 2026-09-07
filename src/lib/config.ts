const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";

export const config = {
  supabaseUrl,
  supabasePublishableKey,
  helpBaseUrl:
    import.meta.env.VITE_HELP_BASE_URL?.trim() ||
    (typeof window === "undefined" ? "https://support-hub-web-production.up.railway.app" : window.location.origin),
  centralSupportEmail: "support@caremetric.ai",
  centralSupportPhone: "+18775212890",
  centralSupportPhoneDisplay: "(877) 521-2890",
  pennTrainBaseUrl: import.meta.env.VITE_PENNTRAIN_BASE_URL?.trim() || "",
  demoMode:
    import.meta.env.VITE_DEMO_MODE === "true" ||
    !supabaseUrl ||
    !supabasePublishableKey,
};
