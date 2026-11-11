do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.visitor-metrics.v1';
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.scorecard.v1"]}'::jsonb) is not true
    or not exists (select 1 from private.hub_settings where key = 'analytics.intel_visitors' and kind = 'flag') then
    raise exception 'Apply the Hub settings, Monday scorecard and visitor metrics setting first' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
