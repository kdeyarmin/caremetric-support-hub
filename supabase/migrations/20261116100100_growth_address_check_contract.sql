-- Declares platform.agents.growth-address-check.v1 once both settings exist, the guard's table is closed to every role, only the Hub
-- server may hand out and record address checks and ask whether an email should wait, the owner's guard functions need a signed-in
-- owner, the helpers are closed to every role, a mailbox that does not exist has its own eligibility, and the Marketing Manager's
-- half-hourly growth.verify task is scheduled.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-address-check.v1';
  server_fns constant text[] := array['private.growth_send_hold(uuid)', 'private.growth_draft_hold(uuid)', 'private.growth_mailbox_candidates(integer)',
    'private.growth_mailbox_record(uuid,text)', 'private.growth_send_guard_state()'];
  helper_fns constant text[] := array['private.growth_presend_mode()', 'private.growth_mailbox_tries()', 'private.growth_bounce_guard()',
    'private.growth_hold_for(uuid,text)', 'private.growth_bounce_guard_latch()'];
  owner_fns constant text[] := array['hub.growth_send_guard()', 'hub.growth_send_guard_resume()'];
  fn text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.growth-autonomy.v1","platform.agents.growth-people-finder.v1","platform.agents.growth-colleagues.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub settings, growth autonomy, people finder and colleagues migrations first' using errcode = '55000';
  end if;
  if not exists (select 1 from private.hub_settings where key = 'growth.presend_check' and kind = 'text')
    or not exists (select 1 from private.hub_settings where key = 'growth.bounce_guard_percent' and kind = 'number') then
    raise exception 'The address check settings are missing' using errcode = '55000';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'private.growth_send_guard'::regclass)
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
               where has_table_privilege(r, 'private.growth_send_guard', 'select') or has_table_privilege(r, 'private.growth_send_guard', 'insert')
                  or has_table_privilege(r, 'private.growth_send_guard', 'update') or has_table_privilege(r, 'private.growth_send_guard', 'delete')) then
    raise exception 'The send guard table must be closed to every role' using errcode = '55000';
  end if;
  foreach fn in array server_fns loop
    if not has_function_privilege('hub_app_server', fn, 'execute')
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute'))
      or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  foreach fn in array helper_fns loop
    if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r where has_function_privilege(r, fn, 'execute')) then
      raise exception '% must be closed to every role', fn using errcode = '55000';
    end if;
  end loop;
  foreach fn in array owner_fns loop
    if not has_function_privilege('authenticated', fn, 'execute')
      or exists (select 1 from unnest(array['anon', 'service_role']) r where has_function_privilege(r, fn, 'execute'))
      or position('hub.authorize_app_' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception '% must need a signed-in owner', fn using errcode = '55000';
    end if;
  end loop;
  -- A mailbox that does not exist is its own eligibility, and only 'permitted' is ever written to.
  if coalesce(position('undeliverable' in (select pg_get_constraintdef(oid) from pg_constraint
                                            where conrelid = 'private.growth_contacts'::regclass and conname = 'growth_contacts_eligibility_check')), 0) = 0 then
    raise exception 'Contacts need the undeliverable eligibility' using errcode = '55000';
  end if;
  if position('c.eligibility<>''permitted''' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) = 0 then
    raise exception 'The send claim must still write only to permitted contacts' using errcode = '55000';
  end if;
  -- A trip holds until the owner resumes: sending notes it, and the guard reads it.
  if position('private.growth_bounce_guard_latch()' in pg_get_functiondef('private.growth_send_hold(uuid)'::regprocedure)) = 0
    or position('tripped_at' in pg_get_functiondef('private.growth_bounce_guard()'::regprocedure)) = 0 then
    raise exception 'A tripped bounce guard must hold until the owner resumes' using errcode = '55000';
  end if;
  -- The guard counts cold email only, and never a soft bounce.
  if position('''growth.cold_email''' in pg_get_functiondef('private.growth_bounce_guard()'::regprocedure)) = 0
    or position('email_suppressions' in pg_get_functiondef('private.growth_bounce_guard()'::regprocedure)) = 0 then
    raise exception 'The bounce guard must count cold email that bounced for good' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.verify') then
    raise exception 'The Marketing Manager''s address check task is not scheduled' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
