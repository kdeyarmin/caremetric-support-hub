export interface SupportHubEnvironment {
  VITE_DEMO_MODE?: string;
  VITE_HELP_BASE_URL?: string;
  VITE_PENNTRAIN_BASE_URL?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  VITE_SUPABASE_URL?: string;
}

const permanentHelpOrigin = "https://support-hub-web-production.up.railway.app";

export function resolveRuntimeConfig(
  environment: SupportHubEnvironment,
  browserOrigin?: string,
) {
  const demoModeSetting = environment.VITE_DEMO_MODE?.trim();
  if (demoModeSetting !== "true" && demoModeSetting !== "false") {
    throw new Error("VITE_DEMO_MODE must be explicitly set to true or false");
  }

  const demoMode = demoModeSetting === "true";
  const supabaseUrl = environment.VITE_SUPABASE_URL?.trim() ?? "";
  const supabasePublishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  if (!demoMode && (!supabaseUrl || !supabasePublishableKey)) {
    throw new Error(
      "Connected Support Hub mode requires VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY",
    );
  }

  return {
    supabaseUrl,
    supabasePublishableKey,
    helpBaseUrl:
      environment.VITE_HELP_BASE_URL?.trim() || browserOrigin || permanentHelpOrigin,
    centralSupportEmail: "support@caremetric.ai",
    centralSupportPhone: "+18775212890",
    centralSupportPhoneDisplay: "(877) 521-2890",
    pennTrainBaseUrl: environment.VITE_PENNTRAIN_BASE_URL?.trim() || "",
    demoMode,
  };
}

export function validateBuildRuntimeConfig(
  environment: SupportHubEnvironment,
  allowDemoBuild: boolean,
) {
  const resolved = resolveRuntimeConfig(environment);
  if (resolved.demoMode && !allowDemoBuild) {
    throw new Error(
      "Production Support Hub builds cannot use demo mode; set VITE_DEMO_MODE=false",
    );
  }
  return resolved;
}
