-- Which agencies opened their market report (owner decision 2026-11-16, docs/AI_WORKFORCE_REVIEW_2026-11-16.md).
--
-- Why. Open and click tracking are off in both mail services, so between a cold email and a reply the team knew nothing: intent was
-- empty on every prospect. Intel now records when a market report link the Hub signed is opened by a person's browser (never a
-- prefetch or a link scanner; no IP address or person) and the Hub reads those opens from Intel's signed POST /api/hub/report-views
-- (Intel docs/HUB_MARKETING_FEED.md "Report views"). The Hub's own check that a report opens signs its link without the reference, so
-- it is never counted.
--
-- 1. Setting (Settings -> Customer growth): "Learn which agencies opened their report" (growth.report_views, off).
-- 2. customer_activity_events may hold 'report_viewed': one per open Intel recorded (event key report_view:<Intel's id>), with the CCN.
--    It is the Hub's own record, never one an app can post (server/growth/policy.mjs eventKinds is unchanged).
-- 3. private.growth_report_view_sync: how far the Hub has read Intel's opens.
-- 4. private.growth_report_views_record: the opens of one page. An open counts only for a CareMetric Intel opportunity whose first email
--    was sent at least two minutes before it (the owner's own preview and a mail service's delivery-time scan are earlier); it records
--    the event, raises the opportunity's intent to at least 50 and notes when its report was first opened, without a new version (a new
--    version would cancel the touch's waiting emails to colleagues). It returns the agencies whose first open this was, for the owner's
--    alert. An open does not stop or start any email: the Marketing Manager's second email reads it (server/growth/draft.mjs).
--
-- Nothing is sent by this migration. 20261116120100_growth_report_views_contract.sql declares platform.agents.growth-report-views.v1.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values ('growth.report_views', 'flag') on conflict (key) do nothing;

alter table private.customer_activity_events drop constraint if exists customer_activity_events_kind_check;
alter table private.customer_activity_events add constraint customer_activity_events_kind_check check (kind in ('signup', 'heartbeat', 'active',
  'first_value', 'trial_started', 'paid', 'renewed', 'cancel_requested', 'churned', 'support_blocked', 'support_resolved', 'expansion_interest',
  'meeting_booked', 'positive_reply', 'reply', 'negative_reply', 'not_now', 'report_viewed'));

create table if not exists private.growth_report_view_sync (
  id boolean primary key default true check (id),
  after_id bigint not null default 0 check (after_id >= 0),
  synced_at timestamptz
);
insert into private.growth_report_view_sync (id) values (true) on conflict (id) do nothing;
alter table private.growth_report_view_sync enable row level security;
revoke all on private.growth_report_view_sync from public, anon, authenticated, service_role, hub_app_server;

-- Server: where the next read of Intel's opens starts.
create or replace function private.growth_report_views_cursor() returns bigint
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 return (select after_id from private.growth_report_view_sync where id);
end; $$;
revoke all on function private.growth_report_views_cursor() from public, anon, authenticated, service_role;
grant execute on function private.growth_report_views_cursor() to hub_app_server;

-- Server: one page of Intel's opens ([{ id, ref, ccn, viewed_at }]) and where the next page starts.
create or replace function private.growth_report_views_record(p_views jsonb, p_next bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb; o private.growth_opportunities%rowtype; v_name text; v_first timestamptz; v_at timestamptz; v_id bigint; v_new boolean;
 v_recorded integer := 0; v_ignored integer := 0; v_first_views jsonb := '[]'::jsonb; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if jsonb_typeof(p_views) is distinct from 'array' or jsonb_array_length(p_views) > 500 or p_next is null or p_next < 0 then
  raise exception 'Invalid page' using errcode = '22023';
 end if;
 for v in select value from jsonb_array_elements(p_views) loop
  begin
   v_id := (v ->> 'id')::bigint; v_at := (v ->> 'viewed_at')::timestamptz;
  exception when others then v_ignored := v_ignored + 1; continue;
  end;
  if coalesce(v ->> 'ref', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or v_at > now() + interval '5 minutes' then
   v_ignored := v_ignored + 1; continue;
  end if;
  select * into o from private.growth_opportunities where id = (v ->> 'ref')::uuid and product = 'caremetric-intel';
  if not found then v_ignored := v_ignored + 1; continue; end if;
  -- The owner's preview and a mail service's delivery-time scan come before, or within two minutes of, the first email.
  select min(attempted_at) into v_first from private.growth_messages where opportunity_id = o.id and purpose = 'marketing' and attempted_at is not null;
  if v_first is null or v_at < v_first + interval '2 minutes' then v_ignored := v_ignored + 1; continue; end if;
  v_new := not exists (select 1 from private.customer_activity_events e where e.organization_id = o.organization_id and e.product = 'caremetric-intel' and e.kind = 'report_viewed');
  insert into private.customer_activity_events(product, organization_id, event_key, kind, occurred_at, facts)
  values ('caremetric-intel', o.organization_id, 'report_view:' || v_id, 'report_viewed', v_at,
    jsonb_strip_nulls(jsonb_build_object('source', 'intel', 'ccn', case when coalesce(v ->> 'ccn', '') ~ '^[0-9A-Z]{6}$' then v ->> 'ccn' end)))
  on conflict (product, event_key) do nothing;
  if not found then v_ignored := v_ignored + 1; continue; end if;
  v_recorded := v_recorded + 1;
  update private.growth_opportunities set intent = greatest(coalesce(intent, 0), 50),
    memory = memory || jsonb_build_object('reportViewedAt', coalesce(memory ->> 'reportViewedAt', v_at::text)), updated_at = now()
   where id = o.id;
  if v_new then
   select name into v_name from private.growth_organizations where id = o.organization_id;
   v_first_views := v_first_views || jsonb_build_array(jsonb_build_object('opportunity', o.id, 'name', v_name, 'viewedAt', v_at));
  end if;
 end loop;
 update private.growth_report_view_sync set after_id = greatest(after_id, p_next), synced_at = now() where id;
 return jsonb_build_object('recorded', v_recorded, 'ignored', v_ignored, 'firstViews', v_first_views);
end; $$;
revoke all on function private.growth_report_views_record(jsonb, bigint) from public, anon, authenticated, service_role;
grant execute on function private.growth_report_views_record(jsonb, bigint) to hub_app_server;

insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('marketing_manager', 'growth.views', 'interval', 900, null, 'America/New_York', false, now())
on conflict (agent_key, task_kind) do nothing;
