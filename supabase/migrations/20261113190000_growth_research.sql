-- Deeper research with web tools (owner plan 2026-11-13). The AI team spent 87 cents on the model in a week against about $20 a day of
-- budget while its prospects waited for evidence. The Marketing Manager may now research one prospect at a time with Anthropic's
-- server-side web search and web fetch (server/agents/runtime/run.mjs `research`):
--
-- - its tool allowlist names web_search and web_fetch, which the runtime now reads: a tool the allowlist does not name is refused;
-- - private.growth_research_next hands out the next prospect worth it (identified or researched, fit unknown or 30 to 74, on its own
--   domain, not researched in 30 days), within Settings -> Customer growth -> "Most prospects to research a day" (5);
-- - Settings -> Customer growth -> "Research prospects with web search" (off) and "Most to spend researching one prospect" (30 cents).
-- What research finds becomes dated evidence through the existing discovery path; it never sends anything or changes a stage.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.deep_research', 'flag'),
  ('growth.deep_research_per_day', 'number'),
  ('growth.deep_research_cents', 'number')
on conflict (key) do nothing;

update private.agents set tool_allowlist = tool_allowlist || array['web_search', 'web_fetch']
 where key = 'marketing_manager' and not (tool_allowlist @> array['web_search', 'web_fetch']);

create table private.growth_research_log (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references private.growth_opportunities(id),
  researched_at timestamptz not null default now()
);
create index growth_research_log_recent on private.growth_research_log (opportunity_id, researched_at desc);
alter table private.growth_research_log enable row level security;
revoke all on private.growth_research_log from public, anon, authenticated, service_role, hub_app_server;

-- Server: the next prospect to research, within the owner's daily number (Eastern day), or null.
create function private.growth_research_next(p_daily integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_used integer; v_pick record; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_daily is null or p_daily < 0 or p_daily > 50 then raise exception 'Invalid daily number' using errcode = '22023'; end if;
 select count(*) into v_used from private.growth_research_log where researched_at >= private.agent_day_start();
 if v_used >= p_daily then return null; end if;
 select o.id, o.organization_id, o.product, o.fit, g.name, g.domain into v_pick
   from private.growth_opportunities o join private.growth_organizations g on g.id = o.organization_id
  where o.owner_agent = 'marketing_manager' and o.stage in ('identified', 'researched') and (o.fit is null or o.fit between 30 and 74)
    and not g.internal and g.tenant_id is null and g.domain !~ '\.invalid$'
    and not exists (select 1 from private.growth_research_log r where r.opportunity_id = o.id and r.researched_at > now() - interval '30 days')
  order by o.fit desc nulls last, o.updated_at, o.id limit 1;
 if not found then return null; end if;
 insert into private.growth_research_log(opportunity_id) values (v_pick.id);
 return jsonb_build_object('id', v_pick.id, 'organizationId', v_pick.organization_id, 'product', v_pick.product, 'fit', v_pick.fit, 'name', v_pick.name, 'domain', v_pick.domain);
end; $$;
revoke all on function private.growth_research_next(integer) from public, anon, authenticated, service_role;
grant execute on function private.growth_research_next(integer) to hub_app_server;

insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('marketing_manager', 'growth.research', 'interval', 3600, null, 'America/New_York', false, now())
on conflict (agent_key, task_kind) do nothing;
