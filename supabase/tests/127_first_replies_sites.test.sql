begin;
select plan(8);

-- The website search's sites and the owner's "Use this site" (20261125161000_first_replies_sites.sql, the Nov 24 follow-up).
select ok(position('''owner''' in (select pg_get_constraintdef(oid) from pg_constraint
            where conrelid = 'private.growth_roster_targets'::regclass and conname = 'growth_roster_targets_confirmation_check')) > 0,
  'A roster agency may be confirmed by the owner');
select ok(position('not in (''phone'', ''name'', ''owner'')' in pg_get_functiondef('private.growth_roster_resolved(text,jsonb)'::regprocedure)) > 0,
  'The roster''s resolution takes the owner''s confirmation');
select ok(position('if v_shared >= 3 and p_data ->> ''confirmation'' not in (''phone'', ''owner'') then' in pg_get_functiondef('private.growth_roster_resolved(text,jsonb)'::regprocedure)) > 0,
  'A host already serving three agencies takes the owner''s choice as it takes the telephone number');
select ok(coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p
                     where p.oid = to_regprocedure('hub.growth_roster_use_site(text,text)')), false),
  'Use this site is a security definer with an empty search path');
select ok(has_function_privilege('authenticated', 'hub.growth_roster_use_site(text,text)', 'execute')
  and not exists (select 1 from unnest(array['anon', 'service_role']) r where has_function_privilege(r, 'hub.growth_roster_use_site(text,text)', 'execute')),
  'Only a signed-in user may ask, and the function decides who may');
select ok(position('hub.authorize_app_command()' in pg_get_functiondef('hub.growth_roster_use_site(text,text)'::regprocedure)) > 0
  and position('t.site_suggestions' in pg_get_functiondef('hub.growth_roster_use_site(text,text)'::regprocedure)) > 0
  and position('private.growth_roster_resolved' in pg_get_functiondef('hub.growth_roster_use_site(text,text)'::regprocedure)) > 0
  and position('growth.roster_site_used' in pg_get_functiondef('hub.growth_roster_use_site(text,text)'::regprocedure)) > 0,
  'Use this site checks the owner, takes only the agency''s own suggestions, resolves as the search does and records the owner');
select ok(not exists (select 1 from private.growth_roster_targets t, unnest(t.site_suggestions) s
                       where s ~ '\.(https?|none|odd|results?|only|try|verify|likely|search|probably|weird)$'),
  'No fragment of a research answer''s prose is kept as a suggested site');
select ok(exists (select 1 from private.audit_events where action = 'growth.roster_site_research_again'),
  'The agencies not found were searched once more, once');

select * from finish();
rollback;
