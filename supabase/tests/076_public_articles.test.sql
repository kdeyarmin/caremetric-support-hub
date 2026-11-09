begin;
select plan(6);

select ok(hub.get_backend_contract() -> 'features' @> '["content.public-articles.v1"]'::jsonb, 'The public article feed is declared in release metadata');

select ok((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = 'private.public_articles(text)'::regprocedure),
  'The read is a security definer with a pinned empty search path');
select ok(has_function_privilege('hub_app_server', 'private.public_articles(text)', 'execute'), 'The Hub server can read the public articles');
select ok(not bool_or(has_function_privilege(role_name, 'private.public_articles(text)', 'execute')), 'No browser or service role can')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) role_name;

select throws_ok($$select private.public_articles('caremetric-intel')$$, '42501', 'Application server required.', 'Any other session is refused before anything is read');
set local role anon;
select throws_ok($$select private.public_articles('caremetric-intel')$$, '42501', null, 'Anonymous callers cannot call it');
reset role;

-- What it returns, and what it never returns, runs through the real roles in server/public-articles-integration.mjs.

select * from finish();
rollback;
