-- Declares platform.agents.owner-sequences.v1 once: the setting exists; the sequence tables and the do-not-contact list are closed to
-- every role; only the Hub server may claim, finish and review emails and record delivery events, unsubscribes and report opens; the
-- claim reads the setting, keeps to 25 prospecting emails a day and never writes to a forbidden or suppressed address or agency; an
-- opt-out forbids the address, the agency's domain and its CCN; the Marketing Manager's cold email reads the do-not-contact list; the
-- Support Concierge never answers or acknowledges a sequence's person on its own; and the Marketing Manager's sequence task is scheduled.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.owner-sequences.v1';
  tables constant text[] := array['private.owner_sequences', 'private.owner_sequence_recipients', 'private.owner_sequence_messages',
    'private.owner_sequence_events', 'private.outreach_do_not_contact'];
  server_fns constant text[] := array['private.owner_sequence_claim()', 'private.owner_sequence_finish(uuid,text,text)', 'private.owner_sequence_review()',
    'private.owner_sequence_delivery(text,uuid,text,timestamp with time zone,boolean)', 'private.owner_sequence_unsubscribe(text)', 'private.owner_sequence_views(jsonb)'];
  owner_fns constant text[] := array['hub.owner_sequences_list()', 'hub.owner_sequence_detail(uuid)', 'hub.owner_sequence_create(jsonb)',
    'hub.owner_sequence_approve(uuid,integer)', 'hub.owner_sequence_stop(uuid,uuid)', 'hub.owner_sequence_discard(uuid)', 'hub.owner_sequence_check(jsonb)'];
  helpers constant text[] := array['private.owner_sequence_blocked(text,text,text)', 'private.owner_sequence_forbid(uuid,text)',
    'private.owner_sequence_stop_recipient(uuid,text,timestamp with time zone)', 'private.owner_sequence_read_replies(uuid)', 'private.owner_sequence_contact(text)'];
  t text; fn text; r text; d text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.customer-growth.v1","platform.agents.growth-autonomy.v1","platform.agents.support-truth.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub settings, customer growth, growth autonomy and support truth migrations first' using errcode = '55000';
  end if;
  if not exists (select 1 from private.hub_settings where key = 'growth.owner_sequences' and kind = 'flag') then
    raise exception 'The owner sequences setting is missing' using errcode = '55000';
  end if;
  foreach t in array tables loop
    if not (select relrowsecurity from pg_class where oid = t::regclass) then raise exception '% must have row level security', t using errcode = '55000'; end if;
    foreach r in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
      if has_table_privilege(r, t, 'select') or has_table_privilege(r, t, 'insert') or has_table_privilege(r, t, 'update') or has_table_privilege(r, t, 'delete') then
        raise exception '% must be closed to %', t, r using errcode = '55000';
      end if;
    end loop;
  end loop;
  foreach fn in array server_fns loop
    if not has_function_privilege('hub_app_server', fn, 'execute')
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) x where has_function_privilege(x, fn, 'execute'))
      or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  foreach fn in array owner_fns loop
    if has_function_privilege('anon', fn, 'execute') or not has_function_privilege('authenticated', fn, 'execute')
      or position('hub.authorize_app_' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception '% must be the owner''s alone', fn using errcode = '55000';
    end if;
  end loop;
  foreach fn in array array['hub.owner_sequence_create(jsonb)', 'hub.owner_sequence_approve(uuid,integer)', 'hub.owner_sequence_stop(uuid,uuid)', 'hub.owner_sequence_discard(uuid)'] loop
    if position('hub.authorize_app_command()' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception '% needs a current owner session', fn using errcode = '55000';
    end if;
  end loop;
  foreach fn in array helpers loop
    if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) x where has_function_privilege(x, fn, 'execute')) then
      raise exception '% must not be run directly', fn using errcode = '55000';
    end if;
  end loop;
  d := pg_get_functiondef('private.owner_sequence_claim()'::regprocedure);
  if position('growth.owner_sequences' in d) = 0 or position('v_all >= 25' in d) = 0 or position('owner_sequence_blocked' in d) = 0
    or position('owner_sequence_read_replies' in d) = 0 or position('isodow' in d) = 0 then
    raise exception 'The send claim must read the setting, the weekday, the mailbox limit, the do-not-contact list and the replies' using errcode = '55000';
  end if;
  d := pg_get_functiondef('private.owner_sequence_read_replies(uuid)'::regprocedure);
  if position('owner_sequence_forbid' in d) = 0 or position('growth_reply_reading' in d) = 0 then
    raise exception 'A "no" or an opt-out must forbid the address and the agency for good' using errcode = '55000';
  end if;
  if position('outreach_do_not_contact' in pg_get_functiondef('private.growth_outreach_stopped(uuid)'::regprocedure)) = 0 then
    raise exception 'The Marketing Manager''s cold email must read the do-not-contact list' using errcode = '55000';
  end if;
  foreach fn in array array['private.agent_answer_begin(uuid,integer,text[])', 'private.agent_acknowledge_begin(uuid,integer,text[])'] loop
    if position('owner_sequence_contact' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception '% must leave a sequence''s person to the owner', fn using errcode = '55000';
    end if;
  end loop;
  if not exists (select 1 from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.sequences') then
    raise exception 'The Marketing Manager''s sequence task is not scheduled' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
