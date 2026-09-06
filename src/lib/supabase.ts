import { createClient } from "@supabase/supabase-js";
import { config } from "./config";

export const supabase = config.demoMode
  ? null
  : createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
