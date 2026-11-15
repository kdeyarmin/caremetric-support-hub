-- Declares platform.agents.growth-colleagues.v1 once a touch can reach several decision-makers at one organization without multiplying
-- touches or escaping a safeguard (20261115230000_growth_colleagues.sql): the owner's number is a setting; a colleague's email is its own
-- message row naming its touch, with no work of its own; only the Hub server lists and records colleague rows; the claim refuses one
-- whose touch is not sent and current, whose person is no longer chosen or that would pass the owner's number, and stops cold email to an
-- organization that opted out or complained; touches count primary rows only; an opt-out, a complaint or a primary contact's hard bounce
-- stops the organization's unsent outreach; and the owner sees who received each touch. The server prepares colleague rows only once
-- this feature is declared.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-colleagues.v1';
  claim text := pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure);
  f text; r text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.growth-reengage.v1","platform.agents.growth-people.v1","platform.agents.growth-soft-bounce.v1"]}'::jsonb) is not true then
    raise exception 'Apply the settings, re-ask, people and soft-bounce migrations first' using errcode = '55000';
  end if;
  if not exists (select 1 from private.hub_settings where key = 'growth.people_per_organization' and kind = 'number') then
    raise exception 'The people-per-organization setting is missing' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'private.growth_messages'::regclass and contype = 'f'
                   and conkey = array[(select attnum from pg_attribute where attrelid = 'private.growth_messages'::regclass and attname = 'primary_message_id')]
                   and confrelid = 'private.growth_messages'::regclass)
    or position('work_id IS NULL' in coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.growth_messages'::regclass
                   and conname = 'growth_messages_colleague_check'), '')) = 0
    or not exists (select 1 from pg_indexes where schemaname = 'private' and tablename = 'growth_messages' and indexname = 'growth_messages_colleague_key'
                   and indexdef like 'CREATE UNIQUE INDEX%') then
    raise exception 'A colleague''s email must be its own message naming its touch, with no work of its own' using errcode = '55000';
  end if;
  foreach f in array array['private.growth_colleague_candidates(integer)', 'private.growth_colleague_draft(uuid,uuid,text)'] loop
    if to_regprocedure(f) is null
      or not exists (select 1 from pg_proc where oid = f::regprocedure and prosecdef and proconfig @> array['search_path=""'] and prosrc like '%require_hub_app_server%')
      or not has_function_privilege('hub_app_server', f, 'execute') then
      raise exception 'Only the Hub server lists and records colleague rows: %', f using errcode = '55000';
    end if;
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, f, 'execute') then raise exception '% exposed to %', f, r using errcode = '55000'; end if;
    end loop;
  end loop;
  foreach f in array array['private.growth_people_per_organization()', 'private.growth_colleague_pool(uuid)', 'private.growth_colleague_primary(uuid)',
    'private.growth_outreach_stopped(uuid)', 'private.growth_colleague_rank(text)', 'private.growth_generic_address(text)'] loop
    if to_regprocedure(f) is null then raise exception '% is missing', f using errcode = '55000'; end if;
    foreach r in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
      if has_function_privilege(r, f, 'execute') then raise exception '% must stay internal', f using errcode = '55000'; end if;
    end loop;
  end loop;
  if private.growth_people_per_organization() not between 1 and 5 or not private.growth_generic_address('info@example.org')
    or private.growth_colleague_rank('Owner') >= private.growth_colleague_rank('Administrator')
    or private.growth_colleague_rank('Administrator') >= private.growth_colleague_rank('Director of Business Development')
    or private.growth_colleague_rank('Director of Business Development') >= private.growth_colleague_rank('Office Manager') then
    raise exception 'The owner''s number and the order of decision-makers are wrong' using errcode = '55000';
  end if;
  if position('private.growth_colleague_primary(m.primary_message_id)' in claim) = 0
    or position('private.growth_colleague_pool(m.primary_message_id)' in claim) = 0
    or position('>=private.growth_people_per_organization()-1' in claim) = 0
    or position('v_cold and private.growth_outreach_stopped(o.organization_id)' in claim) = 0
    or position('m.primary_message_id is null and v_n>=' in claim) = 0
    or position('attempted_at>v_since and primary_message_id is null' in claim) = 0
    or position('x.primary_message_id is null and m.primary_message_id is null' in claim) = 0 then
    raise exception 'The claim must keep colleague rows to a current touch within the owner''s number, count touches once, and honour an organization''s stop' using errcode = '55000';
  end if;
  if position('m.primary_message_id is null) as touches' in pg_get_functiondef('private.growth_snapshot(integer)'::regprocedure)) = 0
    or position('m.primary_message_id is null) as touches' in pg_get_functiondef('private.growth_reengage(integer)'::regprocedure)) = 0
    or position('private.growth_outreach_stopped(o.organization_id)' in pg_get_functiondef('private.growth_reengage(integer)'::regprocedure)) = 0
    or position('m.primary_message_id is null;' in pg_get_functiondef('private.growth_finish_message(uuid,text,text)'::regprocedure)) = 0 then
    raise exception 'Touches must count primary rows only, and a colleague''s email must not move its opportunity' using errcode = '55000';
  end if;
  if position('y.organization_id=v_org and x.purpose=''marketing'' and x.status in (''draft'',''proposed'')' in pg_get_functiondef('private.growth_delivery_event(text,uuid,text,timestamptz,boolean)'::regprocedure)) = 0
    or position('coalesce(m.work_id,(select x.work_id from private.growth_messages x where x.id=m.primary_message_id))' in pg_get_functiondef('private.growth_maintenance_before_lifecycle()'::regprocedure)) = 0 then
    raise exception 'An opt-out, a complaint or a primary contact''s hard bounce must stop the organization''s unsent outreach' using errcode = '55000';
  end if;
  if position('hub.authorize_app_admin()' in pg_get_functiondef('hub.growth_detail(uuid)'::regprocedure)) = 0
    or position('recipients' in pg_get_functiondef('hub.growth_detail(uuid)'::regprocedure)) = 0
    or has_function_privilege('anon', 'hub.growth_detail(uuid)', 'execute') then
    raise exception 'Only the owner sees who received each touch' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
