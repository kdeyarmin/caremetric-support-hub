-- Declares platform.agents.growth-diagnostics.v1 once the address check and account brief features are declared, contacts can hold
-- why a check got no answer (and only one of the known reasons), the two-argument address record is still the Hub server's, the
-- three-argument one and the review record are the Hub server's alone and call the unchanged two-argument record, the reviews table
-- has row level security and is closed to every role, and its read check is closed to every role.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-diagnostics.v1';
  server_fns constant text[] := array['private.growth_mailbox_record(uuid,text)', 'private.growth_mailbox_record(uuid,text,text)',
    'private.growth_review_record(uuid,jsonb)'];
  fn text;
  r text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.growth-address-check.v1","platform.agents.growth-brief.v1"]}'::jsonb) is not true then
    raise exception 'Apply the address check and account brief migrations first' using errcode = '55000';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'private' and table_name = 'growth_contacts' and column_name = 'mailbox_reason')
    or coalesce(position('sender_refused' in (select pg_get_constraintdef(c.oid) from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
        where c.conrelid = 'private.growth_contacts'::regclass and c.contype = 'c' and a.attname = 'mailbox_reason')), 0) = 0 then
    raise exception 'Contacts must hold why a check got no answer, as one of the known reasons' using errcode = '55000';
  end if;
  foreach fn in array server_fns loop
    if not has_function_privilege('hub_app_server', fn, 'execute')
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) x where has_function_privilege(x, fn, 'execute'))
      or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0
      or not coalesce((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = fn::regprocedure), false) then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  -- The reason is recorded after the unchanged answer: the two-argument record still decides eligibility and cancels waiting emails.
  if position('private.growth_mailbox_record(p_contact, p_result)' in pg_get_functiondef('private.growth_mailbox_record(uuid,text,text)'::regprocedure)) = 0
    or position('undeliverable' in pg_get_functiondef('private.growth_mailbox_record(uuid,text)'::regprocedure)) = 0 then
    raise exception 'The reason must be recorded after the address check''s own answer' using errcode = '55000';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'private.growth_message_reviews'::regclass) then
    raise exception 'The reviews table needs row level security' using errcode = '55000';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_table_privilege(r, 'private.growth_message_reviews', 'select') or has_table_privilege(r, 'private.growth_message_reviews', 'insert')
      or has_table_privilege(r, 'private.growth_message_reviews', 'update') or has_table_privilege(r, 'private.growth_message_reviews', 'delete')
      or has_function_privilege(r, 'private.growth_review_read_ok(jsonb)', 'execute') then
      raise exception 'The reviews table and its read check must be closed to every role' using errcode = '55000';
    end if;
  end loop;
  if position('private.growth_review_read_ok' in pg_get_functiondef('private.growth_review_record(uuid,jsonb)'::regprocedure)) = 0 then
    raise exception 'A review must be checked before it is recorded' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
