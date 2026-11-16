import { createAppMediaHandler } from "./handler.ts";
Deno.serve(createAppMediaHandler({ storageOrigin: Deno.env.get("SUPABASE_URL")!, serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! }));
