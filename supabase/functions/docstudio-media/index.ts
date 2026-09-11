import { createImmutableMediaHandler } from '../publication-media/handler.ts';
Deno.serve(createImmutableMediaHandler({profile:'docstudio',serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??''}));
