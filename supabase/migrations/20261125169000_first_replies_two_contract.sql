-- Declares platform.agents.first-replies-2.v1 once the second part of the Nov 24 follow-up is in place
-- (20261125161000_first_replies_sites.sql; server/growth/first-replies.mjs, docs/AI_WORKFORCE_REVIEW_2026-11-17_TEAM.md): a roster agency
-- may be confirmed by the owner, the roster's resolution accepts the owner's confirmation and treats it as the telephone number on a host
-- already serving three agencies, and "Use this site" is a security definer only a signed-in user may ask for, which checks the owner's
-- current session, takes only one of that agency's own suggested sites, resolves it as the search does and records the owner. The first
-- email's one ask and dated reason (growth.21) need nothing from the database. Each test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.first-replies-2.v1';
  use_site constant text := 'hub.growth_roster_use_site(text,text)';
  resolved text;
  definition text;
  r text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.first-replies.v1","platform.agents.growth-reach.v1","platform.agents.growth-roster.v1"]}'::jsonb) is not true then
    raise exception 'Apply the first part of the follow-up, the website search and the roster migrations first' using errcode = '55000';
  end if;
  if position('''owner''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'private.growth_roster_targets'::regclass and conname = 'growth_roster_targets_confirmation_check'), '')) = 0 then
    raise exception 'A roster agency must be confirmable by the owner' using errcode = '55000';
  end if;
  resolved := pg_get_functiondef('private.growth_roster_resolved(text,jsonb)'::regprocedure);
  if position('not in (''phone'', ''name'', ''owner'')' in resolved) = 0
     or position('if v_shared >= 3 and p_data ->> ''confirmation'' not in (''phone'', ''owner'') then' in resolved) = 0
     or position('private.require_hub_app_server()' in resolved) = 0 then
    raise exception 'The roster''s resolution must take the owner''s confirmation and stay the server''s' using errcode = '55000';
  end if;
  if to_regprocedure(use_site) is null
     or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p
                      where p.oid = to_regprocedure(use_site)), false)
     or not has_function_privilege('authenticated', use_site, 'execute') then
    raise exception 'Use this site must be a security definer a signed-in user may ask for' using errcode = '55000';
  end if;
  foreach r in array array['anon', 'service_role'] loop
    if has_function_privilege(r, use_site, 'execute') then raise exception 'Use this site must not be open to %', r using errcode = '55000'; end if;
  end loop;
  definition := pg_get_functiondef(to_regprocedure(use_site));
  if position('hub.authorize_app_command()' in definition) = 0 or position('t.site_suggestions' in definition) = 0
     or position('private.growth_roster_resolved' in definition) = 0 or position('growth.roster_site_used' in definition) = 0
     or position('''confirmation'', ''owner''' in definition) = 0 then
    raise exception 'Use this site must check the owner, take only the agency''s own suggestions, resolve as the search does and record the owner'
      using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
