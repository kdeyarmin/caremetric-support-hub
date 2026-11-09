-- The Chief of Staff's Monday scorecard: one email at 07:50 Eastern in place of the five weekly reports (accounts, growth, SEO,
-- pipeline, social). Six numbers per product with last week's figure beside each, and at most three things that need the owner.
--
-- This migration adds:
--
-- - the owner's setting "Send the individual weekly reports" (private.agent_scorecard_settings, one row). It starts off: once the
--   scorecard is declared, the five weekly reports' scheduled runs stop emailing and the scorecard carries their figures, as long as
--   the Chief of Staff is working and its scorecard schedule is on (otherwise they email as before). "Run now" on any of them still
--   emails it. The owner reads and changes it (hub.get_scorecard_settings, hub.set_individual_reports); a stale
--   screen is refused and every change is audited. The Hub server reads it (private.agent_individual_reports) when each report runs;
-- - the scorecard's one new read, private.agent_scorecard_facts: per product and for one window, the county reports and trial
--   sign-ups from the website (test leads left out), the trials that reached first value for the first time, the outbound emails
--   delivered, bounced and complained about, the replies, and the AI spend recorded on agent runs. Counts and one sum, never a name,
--   an address or a message. Internal organizations are left out, as the pipeline review leaves them out;
-- - the Chief of Staff's daily `scorecard.weekly` schedule at 07:50 Eastern (the work is once per Eastern week).
--
-- Boundary (the same closed shape as the rest of the AI team): the table has row level security and no privilege for any browser,
-- service or server role; the server reads are security definers with a pinned empty search path that refuse every session user but
-- hub_app_server; the owner operations authorize the owner's session themselves; the helpers are executable by no role.

create table private.agent_scorecard_settings (
  id boolean primary key default true check (id),
  -- Whether the five weekly reports' scheduled runs still email the owner beside the scorecard. Off by default.
  individual_reports boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid
);
alter table private.agent_scorecard_settings enable row level security;
revoke all on private.agent_scorecard_settings from public, anon, authenticated, service_role, hub_app_server;
insert into private.agent_scorecard_settings (id, individual_reports) values (true, false) on conflict (id) do nothing;

create function private.agent_scorecard_settings_json(p_row private.agent_scorecard_settings) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('individualReports', p_row.individual_reports, 'changedAt', p_row.changed_at);
$$;

-- Server: whether the five weekly reports' scheduled runs email the owner. A missing row reads as off, the default. They are held only
-- while the scorecard itself goes out: with the Chief of Staff paused or its schedule switched off, they email as before.
create function private.agent_individual_reports() returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return coalesce((select s.individual_reports from private.agent_scorecard_settings s where s.id), false)
    or not exists (select 1 from private.agents a join private.agent_schedules sc on sc.agent_key = a.key
                   where a.key = 'chief_of_staff' and a.status = 'active' and sc.task_kind = 'scorecard.weekly' and sc.enabled);
end;
$$;

-- The scorecard's figures for one window, per product. Counts and the AI spend only.
create function private.agent_scorecard_facts_json(p_since timestamptz, p_until timestamptz) returns jsonb
language sql stable set search_path = '' as $$
  with products(product) as (values ('carebase'), ('caremetric-intel')),
  window_leads as (
    select coalesce(p.slug, private.agent_growth_product(l.source)) as product, l.kind
    from private.leads l left join hub.products p on p.id = l.product_id
    where not l.test and l.received_at >= p_since and l.received_at < p_until and l.kind in ('county_report', 'trial_signup')
  ),
  -- A trial is activated by its first first_value event; a later one for the same organization and product is not a new activation.
  activations as (
    select distinct e.product, e.organization_id
    from private.customer_activity_events e
    join private.growth_organizations g on g.id = e.organization_id
    where not g.internal and e.kind = 'first_value' and e.occurred_at >= p_since and e.occurred_at < p_until
      and not exists (select 1 from private.customer_activity_events earlier
                      where earlier.organization_id = e.organization_id and earlier.product = e.product
                        and earlier.kind = 'first_value' and earlier.occurred_at < p_since)
  ),
  replies as (
    select e.product
    from private.customer_activity_events e
    join private.growth_organizations g on g.id = e.organization_id
    where not g.internal and e.kind in ('reply', 'positive_reply', 'negative_reply', 'not_now')
      and e.occurred_at >= p_since and e.occurred_at < p_until
  ),
  deliveries as (
    select o.product, d.kind
    from private.growth_delivery_events d
    join private.growth_messages m on m.id = d.message_id
    join private.growth_opportunities o on o.id = m.opportunity_id
    join private.growth_organizations g on g.id = o.organization_id
    where not g.internal and d.kind in ('delivered', 'bounced', 'complaint') and d.occurred_at >= p_since and d.occurred_at < p_until
  )
  select jsonb_build_object(
    'since', p_since, 'until', p_until, 'generatedAt', now(),
    'products', (select jsonb_agg(jsonb_build_object(
        'product', x.product,
        'countyReports', (select count(*) from window_leads l where l.product = x.product and l.kind = 'county_report'),
        'trialStarts', (select count(*) from window_leads l where l.product = x.product and l.kind = 'trial_signup'),
        'activated', (select count(*) from activations a where a.product = x.product),
        'delivered', (select count(*) from deliveries d where d.product = x.product and d.kind = 'delivered'),
        'replies', (select count(*) from replies r where r.product = x.product),
        'bounces', (select count(*) from deliveries d where d.product = x.product and d.kind = 'bounced'),
        'complaints', (select count(*) from deliveries d where d.product = x.product and d.kind = 'complaint'))
      order by x.product) from products x),
    'aiSpendCents', (select coalesce(round(sum(r.cost_cents)), 0) from private.agent_runs r where r.started_at >= p_since and r.started_at < p_until));
$$;

-- Server: the scorecard's figures for one window of up to 31 days.
create function private.agent_scorecard_facts(p_since timestamptz, p_until timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_since is null or p_until is null or p_since >= p_until or p_until - p_since > interval '31 days' then
    raise exception 'Choose a period of up to 31 days that ends after it starts.' using errcode = '22023';
  end if;
  return private.agent_scorecard_facts_json(p_since, p_until);
end;
$$;

-- Owner: the scorecard's settings.
create function hub.get_scorecard_settings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform hub.authorize_app_admin();
  return (select private.agent_scorecard_settings_json(s) from private.agent_scorecard_settings s where s.id);
end;
$$;

-- Owner: switch the five weekly reports' own emails on or off. A stale screen is refused.
create function hub.set_individual_reports(p_send boolean, p_expected_changed_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_row private.agent_scorecard_settings%rowtype;
begin
  v_actor := hub.authorize_app_command();
  if p_send is null then
    raise exception 'Choose on or off.' using errcode = '22023';
  end if;
  -- Locked before the version is compared, so of two changes made from the same screen the second is refused instead of applied.
  select * into v_row from private.agent_scorecard_settings where id for update;
  if not found then
    raise exception 'The scorecard settings are missing.' using errcode = 'P0002';
  end if;
  if v_row.changed_at is distinct from p_expected_changed_at then
    raise exception 'This setting changed. Refresh and review again.' using errcode = '40001';
  end if;
  update private.agent_scorecard_settings set individual_reports = p_send, changed_at = now(), changed_by = (v_actor ->> 'user_id')::uuid
  where id returning * into v_row;
  insert into private.audit_events (actor_id, action, entity_type, metadata)
  values ((v_actor ->> 'user_id')::uuid, 'agent.individual_reports', 'agent', jsonb_build_object('send', p_send));
  return private.agent_scorecard_settings_json(v_row);
end;
$$;

revoke all on function private.agent_scorecard_settings_json(private.agent_scorecard_settings), private.agent_individual_reports(),
  private.agent_scorecard_facts_json(timestamptz, timestamptz), private.agent_scorecard_facts(timestamptz, timestamptz)
  from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.agent_individual_reports(), private.agent_scorecard_facts(timestamptz, timestamptz) to hub_app_server;

revoke all on function hub.get_scorecard_settings(), hub.set_individual_reports(boolean, timestamptz) from public, anon, service_role;
grant execute on function hub.get_scorecard_settings(), hub.set_individual_reports(boolean, timestamptz) to authenticated;

-- The schedule fires every morning; the handler sends once per Eastern week (the first run of the week, normally Monday's).
insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('chief_of_staff', 'scorecard.weekly', 'daily', null, '07:50', 'America/New_York', false,
  private.agent_schedule_next('daily', null, '07:50', 'America/New_York', now(), null))
on conflict (agent_key, task_kind) do nothing;
