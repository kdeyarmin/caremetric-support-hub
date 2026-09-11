import { createCommandProxy } from "./handler.ts";

Deno.serve(createCommandProxy({ publishableKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" }));
