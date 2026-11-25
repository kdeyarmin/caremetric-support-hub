-- Declares platform.agents.outreach-intelligence.v1 once the first-email settings exist and a weak first email
-- (arms.hold_review = critic) is left for the owner. The server writes the arms key either way; an older database
-- ignores it and still auto-approves, which is the behavior before this release.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.outreach-intelligence.v1';
  definition text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.first-replies-2.v1"]}'::jsonb) is not true then
    raise exception 'Apply Hub settings and the second first-replies migration first' using errcode = '55000';
  end if;
  if not exists (select 1 from private.hub_settings where key = 'growth.email_one_fact' and kind = 'flag')
     or not exists (select 1 from private.hub_settings where key = 'growth.email_one_offer' and kind = 'flag')
     or not exists (select 1 from private.hub_settings where key = 'growth.booking_url' and kind = 'text') then
    raise exception 'The first-email settings are missing' using errcode = '55000';
  end if;
  definition := pg_get_functiondef('private.growth_propose(uuid,uuid)'::regprocedure);
  if position('hold_review' in definition) = 0 or position('private.require_hub_app_server()' in definition) = 0 then
    raise exception 'A weak first email must stay proposed' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
