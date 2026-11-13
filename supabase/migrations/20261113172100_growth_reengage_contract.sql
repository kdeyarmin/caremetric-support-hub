-- Declares platform.agents.growth-reengage.v1 once a re-ask is a single message after the owner's wait and never after a negative
-- reply, a trial or a sign-up; every found address (role, enriched, imported) is cold email under the owner's cap; and each message
-- records the arms it was written under.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-reengage.v1';
  claim text := pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure);
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.growth-autonomy.v1","platform.agents.growth-inbound.v1","platform.agents.growth-roster.v1"]}'::jsonb) is not true then
    raise exception 'Apply the growth autonomy, inbound and roster migrations first' using errcode = '55000';
  end if;
  if not exists (select 1 from private.hub_settings where key = 'growth.recontact_days' and kind = 'number') then
    raise exception 'The re-ask wait setting is missing' using errcode = '55000';
  end if;
  if private.growth_message_class('marketing_manager', 'marketing', 'enriched') is distinct from 'growth.cold_email'
    or private.growth_message_class('marketing_manager', 'marketing', 'imported') is distinct from 'growth.cold_email'
    or private.growth_message_class('marketing_manager', 'marketing', 'inbound') is distinct from 'growth.sales_followup' then
    raise exception 'Every found address must be cold email; a person who asked never is' using errcode = '55000';
  end if;
  if position('e.kind in (''negative_reply'',''meeting_booked'',''trial_started'',''signup'')' in claim) = 0
    or position('v_n>=(case when v_since>''-infinity''::timestamptz then 1 else p.max_touches end)' in claim) = 0
    or position('private.growth_message_class(''marketing_manager'',x.purpose,xc.source_kind)=''growth.cold_email'' and x.attempted_at>=private.agent_day_start()' in claim) = 0 then
    raise exception 'The claim must allow one re-ask, stop on a negative reply, trial or sign-up, and cap every cold email' using errcode = '55000';
  end if;
  if not has_function_privilege('hub_app_server', 'private.growth_reengage(integer)', 'execute')
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, 'private.growth_reengage(integer)', 'execute'))
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r where has_function_privilege(r, 'private.growth_recontact_days()', 'execute')) then
    raise exception 'Only the Hub server may re-ask' using errcode = '55000';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'private' and table_name = 'growth_messages' and column_name = 'arms') then
    raise exception 'Messages must record their arms' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
