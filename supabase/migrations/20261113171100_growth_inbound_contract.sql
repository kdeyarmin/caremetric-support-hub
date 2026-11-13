-- Declares platform.agents.growth-inbound.v1 once main's own reply reading (20261113150000) and trial link (20261113170000) are still
-- what capture and billing run, only the Hub server may capture a lead or record the Sales Executive's reading, and the follow-up
-- switch exists.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-inbound.v1';
  inquiry text := pg_get_functiondef('private.growth_inquiry(uuid)'::regprocedure);
  customer text := pg_get_functiondef('private.growth_ensure_customer(uuid,text)'::regprocedure);
  fn text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.customer-growth.v1","platform.agents.growth-autonomy.v1","platform.agents.app-growth.v1","support.leads.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub settings, customer growth, growth autonomy, app growth and website lead migrations first' using errcode = '55000';
  end if;
  if not exists (select 1 from private.hub_settings where key = 'growth.inbound_followup' and kind = 'flag') then
    raise exception 'The website lead follow-up setting is missing' using errcode = '55000';
  end if;
  -- Main's reviewed fixes stay what capture and billing run; this migration only builds on them.
  if position('private.growth_reply_reading(v_body)' in inquiry) = 0
    or position('growth_reply_reading' in pg_get_functiondef('private.growth_inbound_trigger()'::regprocedure)) = 0 then
    raise exception 'Replies must be read from the sender''s own words' using errcode = '55000';
  end if;
  if position('growth.customer_linked' in customer) = 0 or position('''customer-''||p_tenant::text||''.invalid''' in customer) = 0 then
    raise exception 'A trial must look for the prospect before creating a customer record' using errcode = '55000';
  end if;
  foreach fn in array array['private.growth_reply_disposition(uuid,text,text)', 'private.growth_lead_capture(uuid)'] loop
    if not has_function_privilege('hub_app_server', fn, 'execute')
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute')) then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
             where has_function_privilege(r, 'private.growth_ensure_customer(uuid,text)', 'execute')) then
    raise exception 'Linking a customer must stay inside the billing and activity functions' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'private.growth_contacts'::regclass and conname = 'growth_contacts_source_kind_check'
                   and pg_get_constraintdef(oid) like '%inbound%') then
    raise exception 'Contacts must record where they came from' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
