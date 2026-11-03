-- The Growth Manager: the AI team's sixth agent. No website lead waits, and the owner sees where customers come from.
-- It reads the lead desk (20261103120000_lead_desk.sql) through the server-only operations below, uses no model and sends
-- nothing to a customer:
--   * growth.leads (every five minutes): each new lead is looked at once. A trial sign-up alerts the owner at once; a demo,
--     consultation or contact request is left to the Support Concierge, which alerts on its conversation; the rest waits for
--     the brief and the weekly report;
--   * growth.followup (every fifteen minutes): a lead conversation nobody has answered is chased, once per step of the agent's
--     followup_minutes, never in its quiet hours;
--   * growth.weekly (every morning at 07:30 Eastern; the work is Monday's): the week's leads, trials, replies and suggestions.
-- The Platform Engineer gains probe.forms (every six hours): a signed probe to each product's lead form, and a check that its
-- test lead reached the Hub, recorded like a health check so two failures in a row open an incident.
-- Like every agent the Growth Manager starts paused and in Observe: nothing runs until the owner resumes it on the AI team page.
--
-- Boundary (the closed shape of the control plane and the lead desk):
--   * the operations are security definers with an empty search path that refuse every session user but hub_app_server, and
--     only that role may execute them. The work of each is an internal helper that no role may execute (so the database tests
--     can exercise it without the Hub server's login);
--   * no operation returns a contact's name, email address, phone number or role, or anything a visitor wrote: leads come back
--     as ids, kinds, products, an organization, a few facts and where the visitor came from; conversations as their reference;
--   * test leads (the form checks' probes) are never pending, never chased and never counted.

set local lock_timeout = '10s';

-- 1. Which leads the Growth Manager has looked at. Set only by agent_growth_mark_seen, which never touches updated_at: the
-- owner's Leads screen refuses a change made since it loaded, and an agent looking at a lead is not a change to it.
alter table private.leads add column if not exists growth_seen_at timestamptz;
create index if not exists leads_growth_pending on private.leads (received_at, id) where growth_seen_at is null and not test;

-- 2. The agent and its schedules. Seeding is idempotent, and a row or setting the owner already changed is left as it is.
insert into private.agents (key, display_name, role_summary, status, autonomy, model_tier, daily_budget_cents, tool_allowlist, config)
values ('growth_manager', 'Growth Manager',
  'Makes sure no website lead waits: emails you each new trial at once, reminds you about any lead conversation nobody has answered, adds yesterday''s leads to the morning brief, and every Monday reports where leads came from with three suggestions. Sends nothing to customers.',
  'paused', 'observe', 'fast', 50, array['notify_owner'],
  '{"followup_minutes": [60, 1440], "quiet_hours": {"start": "21:00", "end": "07:00", "timezone": "America/New_York"}}'::jsonb)
on conflict (key) do nothing;
update private.agents
set config = '{"followup_minutes": [60, 1440], "quiet_hours": {"start": "21:00", "end": "07:00", "timezone": "America/New_York"}}'::jsonb || config
where key = 'growth_manager' and not (config ? 'followup_minutes' and config ? 'quiet_hours');

insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at) values
  ('growth_manager', 'growth.leads', 'interval', 300, null, 'America/New_York', false, now()),
  ('growth_manager', 'growth.followup', 'interval', 900, null, 'America/New_York', false, now()),
  ('growth_manager', 'growth.weekly', 'daily', null, '07:30', 'America/New_York', false,
   private.agent_schedule_next('daily', null, '07:30', 'America/New_York', now(), null)),
  ('platform_engineer', 'probe.forms', 'interval', 21600, null, 'America/New_York', false, now())
on conflict (agent_key, task_kind) do nothing;

-- ---------------------------------------------------------------------------------------
-- Internal helpers. No role executes these directly; the operations below call them.
-- ---------------------------------------------------------------------------------------

-- A lead's product slug from the website it came from, for a lead whose product is not registered (so a report never names one product twice).
create function private.agent_growth_product(p_source text) returns text
language sql immutable set search_path = '' as $$
  select case p_source when 'intel' then 'caremetric-intel' else p_source end;
$$;

-- The lead conversations still waiting for their first answer: a lead that is not a test, still `new` on the Leads screen (a
-- lead the owner moved along, or marked as spam, has been dealt with), whose conversation is not closed and has no reply or
-- internal note after the lead's first inbound message.
create function private.agent_growth_waiting()
returns table (lead_id uuid, kind text, product text, reference bigint, first_inbound_at timestamptz)
language sql stable set search_path = '' as $$
  select l.id, l.kind, coalesce(p.slug, private.agent_growth_product(l.source)), c.reference, f.created_at
  from private.leads l
  join private.communications c on c.id = l.communication_id
  left join hub.products p on p.id = l.product_id
  cross join lateral (
    select m.id, m.created_at from private.communication_messages m
    where m.communication_id = c.id and m.direction = 'inbound'
    order by m.created_at, m.id limit 1) f
  where not l.test and l.status = 'new' and c.status <> 'closed'
    and not exists (
      select 1 from private.communication_messages a
      where a.communication_id = c.id and a.direction in ('outbound', 'note') and (a.created_at, a.id) > (f.created_at, f.id));
$$;

-- New leads, oldest first, from the last p_window_hours: ids, kinds and products only.
create function private.agent_growth_pending_json(p_limit integer, p_window_hours integer) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'source', x.source) order by x.received_at, x.id), '[]'::jsonb)
  from (
    select l.id, l.kind, l.source, l.received_at from private.leads l
    where l.growth_seen_at is null and not l.test and l.received_at >= now() - make_interval(hours => p_window_hours)
    order by l.received_at, l.id
    limit p_limit) x;
$$;

-- One lead as an alert may name it. Never the contact's name, address, phone number or role, and never the message (which is
-- stored only in its conversation). Facts are the first six, by key, each string clipped to 80 characters.
create function private.agent_growth_lead_json(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', l.id, 'kind', l.kind, 'source', l.source, 'test', l.test, 'receivedAt', l.received_at,
    'productSlug', p.slug,
    'organization', l.organization,
    'details', (select coalesce(jsonb_object_agg(d.key, case when jsonb_typeof(d.value) = 'string' then to_jsonb(left(d.value #>> '{}', 80)) else d.value end), '{}'::jsonb)
                from (select e.key, e.value from jsonb_each(l.details) e order by e.key limit 6) d),
    'attribution', jsonb_build_object(
      'source', lower(coalesce(l.utm_source, l.referrer_host, 'direct')), 'medium', l.utm_medium, 'campaign', l.utm_campaign, 'landingPath', l.landing_path),
    'reference', case when c.id is null then null else 'CM-' || c.reference end)
  from private.leads l
  left join hub.products p on p.id = l.product_id
  left join private.communications c on c.id = l.communication_id
  where l.id = p_id;
$$;

-- Marks leads as looked at. Returns how many were newly marked; updated_at is left alone (see the column above).
create function private.agent_growth_mark_seen_rows(p_ids uuid[]) returns integer
language plpgsql set search_path = '' as $$
declare
  v_count integer;
begin
  update private.leads set growth_seen_at = now() where id = any (p_ids) and growth_seen_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Lead conversations waiting longer than p_older_than_minutes, the most recent first (so the newest crossings are never crowded out).
create function private.agent_growth_unanswered_json(p_older_than_minutes integer, p_limit integer) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'leadId', w.lead_id, 'kind', w.kind, 'product', w.product, 'reference', 'CM-' || w.reference, 'minutesWaiting', w.minutes)
    order by w.minutes, w.lead_id), '[]'::jsonb)
  from (
    select x.lead_id, x.kind, x.product, x.reference, floor(extract(epoch from now() - x.first_inbound_at) / 60)::integer as minutes
    from private.agent_growth_waiting() x
    where x.first_inbound_at <= now() - make_interval(mins => p_older_than_minutes)
    order by x.first_inbound_at desc, x.lead_id
    limit p_limit) w;
$$;

-- Counts for the brief and the weekly report: the leads received in [p_since, p_until) that are not tests, by kind, product
-- (the registered product's slug, else the website's) and source (utm_source, else the referring host, else 'direct'; the top 20 and
-- how many more), the top five landing pages and campaigns, trials started (trial sign-up leads, and live-mode Stripe trials
-- that began in the window), trials converted (live-mode subscriptions whose trial ended in the window and that are active),
-- the median minutes to the first reply on those leads' conversations, and the lead conversations unanswered now.
create function private.agent_growth_facts_json(p_since timestamptz, p_until timestamptz) returns jsonb
language sql stable set search_path = '' as $$
  with window_leads as (
    select l.id, l.kind, l.communication_id, l.landing_path, l.utm_campaign,
      coalesce(p.slug, private.agent_growth_product(l.source)) as product, lower(coalesce(l.utm_source, l.referrer_host, 'direct')) as source_label
    from private.leads l left join hub.products p on p.id = l.product_id
    where not l.test and l.received_at >= p_since and l.received_at < p_until
  ),
  sources as (
    select source_label, count(*) as n, row_number() over (order by count(*) desc, source_label) as position
    from window_leads group by source_label
  ),
  first_replies as (
    select extract(epoch from (o.created_at - f.created_at)) / 60 as minutes
    from window_leads w
    cross join lateral (
      select m.id, m.created_at from private.communication_messages m
      where m.communication_id = w.communication_id and m.direction = 'inbound' order by m.created_at, m.id limit 1) f
    cross join lateral (
      select m.created_at from private.communication_messages m
      where m.communication_id = w.communication_id and m.direction = 'outbound' and (m.created_at, m.id) > (f.created_at, f.id)
      order by m.created_at, m.id limit 1) o
  ),
  waiting as (
    select x.kind, floor(extract(epoch from now() - x.first_inbound_at) / 60)::integer as minutes from private.agent_growth_waiting() x
  )
  select jsonb_build_object(
    'since', p_since, 'until', p_until, 'generatedAt', now(),
    'leads', jsonb_build_object(
      'total', (select count(*) from window_leads),
      'byKind', (select jsonb_object_agg(k.kind, coalesce(n.n, 0))
                 from unnest(array['demo_request','consultation','contact','trial_signup','newsletter','savings_model','county_report']) as k(kind)
                 left join (select kind, count(*) as n from window_leads group by kind) n on n.kind = k.kind),
      'byProduct', (select coalesce(jsonb_agg(jsonb_build_object('product', x.product, 'count', x.n) order by x.n desc, x.product), '[]'::jsonb)
                    from (select product, count(*) as n from window_leads group by product) x),
      'bySource', (select coalesce(jsonb_agg(jsonb_build_object('source', s.source_label, 'count', s.n) order by s.position), '[]'::jsonb)
                   from sources s where s.position <= 20),
      'otherSources', (select coalesce(sum(s.n), 0) from sources s where s.position > 20),
      'landingPaths', (select coalesce(jsonb_agg(jsonb_build_object('path', x.landing_path, 'count', x.n) order by x.n desc, x.landing_path), '[]'::jsonb)
                       from (select landing_path, count(*) as n from window_leads where landing_path is not null
                             group by landing_path order by count(*) desc, landing_path limit 5) x),
      'campaigns', (select coalesce(jsonb_agg(jsonb_build_object('campaign', x.utm_campaign, 'count', x.n) order by x.n desc, x.utm_campaign), '[]'::jsonb)
                    from (select utm_campaign, count(*) as n from window_leads where utm_campaign is not null
                          group by utm_campaign order by count(*) desc, utm_campaign limit 5) x)),
    'trials', jsonb_build_object(
      'started', (select count(*) from window_leads where kind = 'trial_signup'),
      'subscriptions', (select count(*) from private.billing_subscriptions s
                        where s.livemode and s.trial_start >= p_since and s.trial_start < p_until),
      'converted', (select count(*) from private.billing_subscriptions s
                    where s.livemode and s.status = 'active' and s.trial_end >= p_since and s.trial_end < p_until)),
    'replies', (select jsonb_build_object('replied', count(*),
                  'medianMinutes', round((percentile_cont(0.5) within group (order by r.minutes))::numeric))
                from first_replies r),
    'unanswered', jsonb_build_object(
      'count', (select count(*) from waiting),
      'oldestMinutes', (select max(minutes) from waiting),
      'byKind', (select coalesce(jsonb_object_agg(x.kind, x.n), '{}'::jsonb) from (select kind, count(*) as n from waiting group by kind) x)));
$$;

-- Whether a test lead from p_source reached the Hub at or after p_since: the end of a lead form check.
create function private.agent_growth_probe_seen(p_source text, p_since timestamptz) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from private.leads l where l.source = p_source and l.test and l.received_at >= p_since);
$$;

-- ---------------------------------------------------------------------------------------
-- Server operations. Executable by hub_app_server only; each refuses every other session user first, then checks its input.
-- ---------------------------------------------------------------------------------------

create function private.agent_growth_pending(p_limit integer, p_window_hours integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'List between 1 and 100 leads.' using errcode = '22023';
  end if;
  if p_window_hours is null or p_window_hours < 1 or p_window_hours > 720 then
    raise exception 'Choose a window between 1 and 720 hours.' using errcode = '22023';
  end if;
  return private.agent_growth_pending_json(p_limit, p_window_hours);
end;
$$;

create function private.agent_growth_lead(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_id is null then
    raise exception 'Choose a lead.' using errcode = '22023';
  end if;
  return private.agent_growth_lead_json(p_id);
end;
$$;

create function private.agent_growth_mark_seen(p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_ids is null or cardinality(p_ids) > 100 or array_position(p_ids, null) is not null then
    raise exception 'Mark between 0 and 100 leads.' using errcode = '22023';
  end if;
  return private.agent_growth_mark_seen_rows(p_ids);
end;
$$;

create function private.agent_growth_unanswered(p_older_than_minutes integer, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_older_than_minutes is null or p_older_than_minutes < 1 or p_older_than_minutes > 43200 then
    raise exception 'Choose a wait between 1 and 43200 minutes.' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'List between 1 and 100 conversations.' using errcode = '22023';
  end if;
  return private.agent_growth_unanswered_json(p_older_than_minutes, p_limit);
end;
$$;

create function private.agent_growth_facts(p_since timestamptz, p_until timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_since is null or p_until is null or p_since >= p_until or p_until - p_since > interval '93 days' then
    raise exception 'Choose a period of up to 93 days that ends after it starts.' using errcode = '22023';
  end if;
  return private.agent_growth_facts_json(p_since, p_until);
end;
$$;

create function private.agent_lead_probe_seen(p_source text, p_since timestamptz) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_source is null or p_source not in ('carebase', 'intel', 'advisors') then
    raise exception 'Choose carebase, intel or advisors.' using errcode = '22023';
  end if;
  if p_since is null or p_since < now() - interval '1 day' then
    raise exception 'Choose a time within the last day.' using errcode = '22023';
  end if;
  return private.agent_growth_probe_seen(p_source, p_since);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The conversation snapshot the Support Concierge reads, as before, plus sourceSystem: which system the conversation came from (one
-- of a fixed list, never contact data), so a website lead's conversation is recognised as a prospect's and gets the sales reply.
-- ---------------------------------------------------------------------------------------
create or replace function private.agent_communication_snapshot(
  p_id uuid, p_request_key uuid, p_messages integer, p_chars integer
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c private.communications%rowtype;
  v_inbound_id uuid;
  v_inbound_at timestamptz;
  v_head uuid;
  v_answered boolean := false;
  v_messages jsonb := '[]'::jsonb;
begin
  perform private.require_hub_app_server();
  if p_messages is null or p_messages < 0 or p_messages > 10 then
    raise exception 'Read between 0 and 10 messages.' using errcode = '22023';
  end if;
  if p_chars is null or p_chars < 100 or p_chars > 4000 then
    raise exception 'Clip messages to between 100 and 4000 characters.' using errcode = '22023';
  end if;
  select * into c from private.communications where id = p_id;
  if not found then
    return null;
  end if;
  select i.id, i.created_at into v_inbound_id, v_inbound_at from private.communication_messages i
  where i.communication_id = c.id and i.direction = 'inbound'
  order by i.created_at desc, i.id desc limit 1;
  select m.id into v_head from private.communication_messages m
  where m.communication_id = c.id and m.direction in ('inbound', 'outbound')
    and (p_request_key is null or m.request_key is distinct from p_request_key)
  order by m.created_at desc, m.id desc limit 1;
  if v_inbound_id is not null then
    v_answered := exists (
      select 1 from private.communication_messages a
      where a.communication_id = c.id and a.direction in ('outbound', 'note') and (a.created_at, a.id) > (v_inbound_at, v_inbound_id));
  end if;
  if p_messages > 0 then
    select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'direction', t.direction, 'at', t.created_at, 'body', left(t.body, p_chars))
                              order by t.created_at, t.id), '[]'::jsonb)
    into v_messages
    from (
      select m.id, m.direction, m.created_at, m.body from private.communication_messages m
      where m.communication_id = c.id and m.direction in ('inbound', 'outbound')
      order by m.created_at desc, m.id desc limit p_messages) t;
  end if;
  return jsonb_build_object(
    'id', c.id, 'reference', c.reference, 'channel', c.channel, 'status', c.status, 'inquiryType', c.inquiry_type,
    'sourceSystem', c.source_system,
    'productSlug', (select p.slug from hub.products p where p.id = c.product_id),
    'createdAt', c.created_at, 'updatedAt', c.updated_at,
    'canEmail', c.contact_email is not null,
    'canText', coalesce(c.contact_phone ~ '^\+[1-9][0-9]{7,14}$', false),
    -- Subjects of phone and web-form conversations name the caller, and a text's carries the number.
    'subject', case when c.channel = 'email' then c.subject end,
    'headMessageId', v_head, 'latestInboundId', v_inbound_id, 'answered', v_answered,
    -- How many times each side has written, so a first message (nobody has replied yet) can be told from a follow-up.
    'inboundCount', (select count(*) from private.communication_messages x where x.communication_id = c.id and x.direction = 'inbound'),
    'outboundCount', (select count(*) from private.communication_messages x where x.communication_id = c.id and x.direction = 'outbound'),
    'ownReplyDelivery', (select o.delivery from private.communication_messages o
                         where p_request_key is not null and o.communication_id = c.id and o.direction = 'outbound' and o.request_key = p_request_key),
    'messages', v_messages);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Grants. Helpers: nobody. Operations: the Hub server role only. (create or replace keeps the snapshot's grants.)
-- ---------------------------------------------------------------------------------------
revoke all on function
  private.agent_growth_product(text),
  private.agent_growth_waiting(),
  private.agent_growth_pending_json(integer, integer),
  private.agent_growth_lead_json(uuid),
  private.agent_growth_mark_seen_rows(uuid[]),
  private.agent_growth_unanswered_json(integer, integer),
  private.agent_growth_facts_json(timestamp with time zone, timestamp with time zone),
  private.agent_growth_probe_seen(text, timestamp with time zone),
  private.agent_growth_pending(integer, integer),
  private.agent_growth_lead(uuid),
  private.agent_growth_mark_seen(uuid[]),
  private.agent_growth_unanswered(integer, integer),
  private.agent_growth_facts(timestamp with time zone, timestamp with time zone),
  private.agent_lead_probe_seen(text, timestamp with time zone)
from public, anon, authenticated, service_role, hub_app_server;

grant execute on function
  private.agent_growth_pending(integer, integer),
  private.agent_growth_lead(uuid),
  private.agent_growth_mark_seen(uuid[]),
  private.agent_growth_unanswered(integer, integer),
  private.agent_growth_facts(timestamp with time zone, timestamp with time zone),
  private.agent_lead_probe_seen(text, timestamp with time zone)
to hub_app_server;
