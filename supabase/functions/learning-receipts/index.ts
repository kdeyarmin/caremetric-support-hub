import { createLearningReceiptProxy } from "./handler.ts";
Deno.serve(createLearningReceiptProxy({ publishableKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "" }));
