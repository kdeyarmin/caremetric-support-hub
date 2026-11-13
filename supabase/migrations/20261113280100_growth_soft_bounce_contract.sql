-- Declares platform.agents.growth-soft-bounce.v1 once an SES failure that is not the recipient's fault can be recorded without opting
-- the contact out (20261113280000_growth_soft_bounce_reporting.sql), while complaints, unsubscribes and four-argument bounces still
-- suppress and both forms stay guarded Hub server functions.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-soft-bounce.v1';
  soft constant text := 'private.growth_delivery_event(text,uuid,text,timestamptz,boolean)';
  legacy constant text := 'private.growth_delivery_event(text,uuid,text,timestamptz)';
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.customer-growth.v1"]}'::jsonb) is not true then
    raise exception 'Apply the customer growth migrations first' using errcode = '55000';
  end if;
  if to_regprocedure(soft) is null
     or position('coalesce(p_suppress,true)' in pg_get_functiondef(soft::regprocedure)) = 0
     or position('private.growth_delivery_event(p_event,p_message,p_kind,p_at,true)' in pg_get_functiondef(legacy::regprocedure)) = 0
     or not has_function_privilege('hub_app_server', soft, 'execute')
     or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, soft, 'execute')) then
    raise exception 'Soft-bounce reporting must be in place and Hub-server only' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
