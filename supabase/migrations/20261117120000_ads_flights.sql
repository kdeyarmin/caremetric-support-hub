-- Ad budget flights (owner decision 2026-11-16): Settings → Paid ads → "Run each month's campaign as a short flight" spends the monthly
-- number in one campaign over a few days, at no less than the platform's least daily budget, ending on its own
-- (server/agents/ads/index.mjs `flightBudget`). A small monthly number spread a thirtieth a day is below every platform's least, so no
-- campaign could run. A launch handed over reserves the flight's own days (private.ads_launch_reserve already takes them), so the
-- month's number still bounds what it spends.
insert into private.hub_settings (key, kind) values ('ads.flight_days', 'number') on conflict (key) do nothing;

-- This month's campaign actions on every platform and product, whatever is connected or marketed now, so the plan can tell whether the
-- month's flight is taken: by a campaign that was created (whatever its pacing) or a flight still proposed, approved or turned down, never
-- by a proposal that failed, expired or was paced for the whole month and never created. Kind, target, status and whether it is a flight;
-- nothing else of the action.
create or replace function private.ads_month_campaigns(p_month text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
  perform private.require_hub_app_server();
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'Invalid month' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'targetId', target_id, 'status', status, 'flight', input ? 'flightDays') order by created_at, id)
    from private.agent_actions where kind in ('social.campaign_create', 'social.google_campaign') and split_part(target_id, ':', 3) = p_month), '[]'::jsonb);
end; $$;
revoke all on function private.ads_month_campaigns(text) from public, anon, authenticated, service_role;
grant execute on function private.ads_month_campaigns(text) to hub_app_server;
