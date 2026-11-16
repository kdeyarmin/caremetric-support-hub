-- Declares platform.agents.work-recovery.v1 once the creative, ads, address check, people finder, app growth, watchdog and hand-over
-- features are declared; the new server operations (blocked images rendered again, the ad platforms' refusals) and the replaced county
-- choice and watchdog facts are executable by the Hub server alone and require its connection; the helpers are closed to every role; and
-- each change the 2026-11-17 review asked for is in place (a county counts only while its snapshot pictures it, the bounce guard trips
-- on two bounces against at least 20 emails, a mail server's confirmation is recorded, intent follows each event, a trial from the owner's
-- or a CareMetric address is internal, and the watchdog reads what was lost).
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.work-recovery.v1';
  server_fns constant text[] := array['private.creative_render_requeue(boolean)', 'private.ads_platform_refusals()',
    'private.creative_data_counties(integer,timestamptz,jsonb)', 'private.agent_watchdog_facts()'];
  helper_fns constant text[] := array['private.creative_brief_pictured(uuid)', 'private.growth_internal_address(text)', 'private.growth_event_intent()'];
  fn text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.creative-review.v1","platform.agents.ads.v1","platform.agents.growth-address-check.v1","platform.agents.growth-people-finder.v1","platform.agents.app-growth.v1","platform.agents.watchdog.v1","platform.agents.autonomy-handover.v1"]}'::jsonb) is not true then
    raise exception 'Apply the creative review, ads, address check, people finder, app growth, watchdog and hand-over migrations first' using errcode = '55000';
  end if;
  foreach fn in array server_fns loop
    if to_regprocedure(fn) is null or not has_function_privilege('hub_app_server', fn, 'execute')
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute'))
      or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  foreach fn in array helper_fns loop
    if to_regprocedure(fn) is null
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r where has_function_privilege(r, fn, 'execute')) then
      raise exception '% must be closed to every role', fn using errcode = '55000';
    end if;
  end loop;
  if position('private.creative_brief_pictured' in pg_get_functiondef('private.creative_data_counties(integer,timestamptz,jsonb)'::regprocedure)) = 0
    or position('interval ''56 days''' in pg_get_functiondef('private.creative_data_counties(integer,timestamptz,jsonb)'::regprocedure)) = 0 then
    raise exception 'A county must count as pictured only while its snapshot pictures it, and rest eight weeks after' using errcode = '55000';
  end if;
  if position('creative-vision.1' in pg_get_functiondef('private.creative_render_requeue(boolean)'::regprocedure)) = 0
    or position('p_vision' in pg_get_functiondef('private.creative_render_requeue(boolean)'::regprocedure)) = 0 then
    raise exception 'Only images blocked by the first image review, while the review is on, may be rendered again' using errcode = '55000';
  end if;
  if position('greatest(v_sent, 20)' in pg_get_functiondef('private.growth_bounce_guard()'::regprocedure)) = 0
    or position('email_suppressions' in pg_get_functiondef('private.growth_bounce_guard()'::regprocedure)) = 0 then
    raise exception 'The bounce guard must trip on hard bounces counted against at least 20 emails' using errcode = '55000';
  end if;
  if position('mailbox_result = ''verified''' in pg_get_functiondef('private.growth_person_address(uuid,text,text,text,text)'::regprocedure)) = 0 then
    raise exception 'A mail server''s confirmation must be recorded with the address' using errcode = '55000';
  end if;
  if position('private.growth_internal_address' in pg_get_functiondef('private.growth_ensure_customer(uuid,text)'::regprocedure)) = 0 then
    raise exception 'A trial from the owner''s or a CareMetric address must be internal' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'private.customer_activity_events'::regclass and tgname = 'growth_event_intent' and not tgisinternal) then
    raise exception 'Intent must follow each activity event' using errcode = '55000';
  end if;
  if position('''losses''' in pg_get_functiondef('private.agent_watchdog_facts()'::regprocedure)) = 0 then
    raise exception 'The watchdog must read what the team lost' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
