-- Additive deployment gate for the SEO Analyst. Declaring the feature changes no behavior: it states that the
-- agent and its weekly schedule exist, so a Hub that offers the agent always has the rows its handler runs from.
-- The tables and operations it uses are the control plane's, already guarded by the first gate.
do $$
declare
  contract jsonb := hub.get_backend_contract();
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI team control plane first' using errcode = '55000';
  end if;

  if not exists (select 1 from private.agents where key = 'seo_analyst') then
    raise exception 'The SEO Analyst agent must exist' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'seo_analyst' and task_kind = 'seo.weekly' and cadence = 'daily') then
    raise exception 'The SEO Analyst weekly schedule must exist' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> '["platform.agents.seo.v1"]'::jsonb) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || '["platform.agents.seo.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
