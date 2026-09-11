import { createAdminProxy } from "./handler.ts";

// Supabase supplies this browser-safe legacy anon key to Edge Functions.
// The user's JWT is validated by PostgREST and the relational authorization RPC.
Deno.serve(createAdminProxy({ publishableKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" }));
