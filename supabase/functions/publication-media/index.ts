import { createPublicationMediaHandler } from "./handler.ts";
Deno.serve(createPublicationMediaHandler({ serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "" }));
