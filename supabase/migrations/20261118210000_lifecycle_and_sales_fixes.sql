-- Repairs from the 2026-11-18 application audit:
-- 1. The Account Manager's customer emails (private.agent_lifecycle_json and private.agent_lifecycle_begin_send) and the strategist's
--    no-card count (private.growth_strategy_facts_json) leave out internal organizations and trials started from the owner's address or
--    a CareMetric address (private.growth_internal_address, 20261117180000_work_recovery.sql), including Intel sign-ups that have not yet
--    added a card and therefore have no growth_organizations row yet.
-- 2. The Sales Executive's growth context (private.sales_growth_context_read) includes prospects in the 'trial' stage, matching
--    private.sales_handoff after 20261117230000_trial_path.sql.
set local lock_timeout = '10s';

create or replace function private.agent_lifecycle_json(p_limit integer, p_tenant text, p_product text, p_offset integer) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_live boolean;
begin
  select livemode into v_live from private.billing_settings;
  return (
    with live as (
      select distinct on (s.tenant_id, s.product_id) s.tenant_id, s.product_id, s.stripe_subscription_id, s.status, s.trial_start, s.trial_end,
        s.stripe_created, (s.cancel_at_period_end or s.cancel_at is not null) as cancelling
      from private.billing_subscriptions s
      join hub.tenants t on t.id = s.tenant_id and t.status = 'active'
      join hub.products p on p.id = s.product_id and p.status <> 'retired'
      where s.livemode and coalesce(v_live, true) and s.status in ('trialing', 'active', 'canceled', 'incomplete_expired', 'paused')
        and (p_tenant is null or t.slug = p_tenant) and (p_product is null or p.slug = p_product)
        and not exists (select 1 from private.growth_organizations g where g.tenant_id = s.tenant_id and g.internal)
        and not exists (select 1 from private.billing_customers bc where bc.tenant_id = s.tenant_id and not bc.deleted and bc.livemode and private.growth_internal_address(bc.email))
      order by s.tenant_id, s.product_id, s.stripe_created desc, s.stripe_subscription_id
    ), paid as (
      select l.*, (select min(i.stripe_created) from private.billing_invoices i
                   join private.billing_subscriptions hs on hs.stripe_subscription_id = i.stripe_subscription_id
                   where hs.tenant_id = l.tenant_id and hs.product_id = l.product_id and hs.livemode
                     and i.status = 'paid' and i.amount_paid > 0 and i.livemode) as first_paid_at
      from live l
    ), chosen as (
      select * from paid where status = 'trialing' or (status = 'active' and first_paid_at >= now() - interval '90 days')
        -- A plan being cancelled, however long it was paid for, and a trial that ended unpaid in the last 14 days.
        or (status in ('trialing', 'active') and cancelling)
        or (status in ('canceled', 'incomplete_expired', 'paused') and first_paid_at is null
            and trial_end is not null and trial_end <= now() and trial_end > now() - interval '14 days'
            -- The newest subscription of any status decides: one started since (incomplete, past due or unpaid included) means
            -- the customer came back, so the ended trial is not theirs to be asked about.
            and not exists (select 1 from private.billing_subscriptions n where n.tenant_id = paid.tenant_id and n.product_id = paid.product_id
              and n.livemode and n.stripe_subscription_id <> paid.stripe_subscription_id and n.stripe_created >= paid.stripe_created))
    ), contact as (
      -- The address is read only to say whether it is usable and whether it unsubscribed; it never leaves this statement.
      select c.tenant_id,
        btrim(c.email) ~ '^[^[:space:]@<>"]+@[^[:space:]@<>"]+\.[^[:space:]@<>"]+$' as usable,
        exists (select 1 from private.email_suppressions x where x.email_hash = private.email_hash(c.email)) as suppressed
      from private.billing_customers c
      where c.tenant_id in (select tenant_id from chosen) and not c.deleted and c.livemode
    ), activity as (
      -- Trial path: the product's own activity events for the account (never a heartbeat, which only says the product's worker ran).
      select ch.tenant_id, ch.product_id,
        max(e.occurred_at) filter (where e.kind in ('active', 'first_value')) as active_at,
        min(e.occurred_at) filter (where e.kind = 'first_value') as first_value_at,
        bool_or(e.kind = 'active' and e.facts ->> 'metric' = 'county_chosen') as county_chosen
      from chosen ch
      join hub.products p on p.id = ch.product_id
      join private.growth_organizations g on g.tenant_id = ch.tenant_id
      join private.customer_activity_events e on e.organization_id = g.id and e.product = p.slug
      group by ch.tenant_id, ch.product_id
    ), page as (
      select ch.stripe_created as created, t.slug as tenant, p.slug as product, jsonb_build_object(
        'tenant', t.slug, 'tenantName', t.name, 'product', p.slug, 'productName', p.name, 'status', ch.status,
        'trialStart', ch.trial_start, 'trialEnd', ch.trial_end, 'created', ch.stripe_created, 'firstPaidAt', ch.first_paid_at,
        'cancelling', ch.cancelling,
        'hasEmail', coalesce(ct.usable, false),
        'suppressed', coalesce(ct.usable and ct.suppressed, false),
        'hasUsage', exists (select 1 from private.billing_usage_reports u where u.tenant_id = ch.tenant_id and u.product_id = ch.product_id and u.quantity > 0),
        'openUrgentCases', (select count(*) from hub.support_cases sc join hub.products cp on cp.id = sc.product_id and cp.status <> 'retired'
          where sc.tenant_id = ch.tenant_id and sc.status in ('open', 'in_progress', 'waiting_on_customer') and sc.priority in ('high', 'urgent')),
        -- Trial path facts.
        'cardConfirmedAt', (select gc.first_confirmed_at from private.growth_trial_cards gc where gc.stripe_subscription_id = ch.stripe_subscription_id),
        'activeAt', a.active_at, 'firstValueAt', a.first_value_at, 'countyChosen', coalesce(a.county_chosen, false),
        'emails', (select jsonb_object_agg(tpl, (select a2.status from private.agent_actions a2
              where a2.kind = 'email.send' and a2.input ->> 'periodKey' = 'account:' || tpl || ':' || t.slug || ':' || p.slug))
          from unnest(array['welcome', 'setup_nudge', 'trial_checkin', 'testimonial_ask', 'cancel_save', 'trial_ended',
            'card_reminder', 'midtrial_nudge', 'value_followup']) tpl)) as fact
      from chosen ch
      join hub.tenants t on t.id = ch.tenant_id
      join hub.products p on p.id = ch.product_id
      left join contact ct on ct.tenant_id = ch.tenant_id
      left join activity a on a.tenant_id = ch.tenant_id and a.product_id = ch.product_id
      order by ch.stripe_created desc, t.slug, p.slug
      offset p_offset limit p_limit
    )
    select jsonb_build_object(
      'generatedAt', now(),
      'mode', case when v_live is null then 'unverified' when v_live then 'live' else 'test' end,
      'total', (select count(*)::integer from chosen),
      'truncated', (select count(*) from chosen) > p_offset + p_limit,
      'accounts', coalesce((select jsonb_agg(page.fact order by page.created desc, page.tenant, page.product) from page), '[]'::jsonb)));
end;
$$;
revoke all on function private.agent_lifecycle_json(integer, text, text, integer) from public, anon, authenticated, service_role, hub_app_server;

create or replace function private.agent_lifecycle_begin_send(p_action_id uuid, p_execution integer, p_unsubscribe_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action private.agent_actions%rowtype;
  v_agent private.agents%rowtype;
  v_recorded text;
  v_live boolean;
  v_tenant uuid;
  v_email text;
  v_hash text;
begin
  perform private.require_hub_app_server();
  -- Growth and native lifecycle claims share this lock before taking any row lock or send reservation.
  perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
  if p_unsubscribe_hash is not null and p_unsubscribe_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Choose an unsubscribe link.' using errcode = '22023';
  end if;
  select * into v_action from private.agent_actions where id = p_action_id for update;
  if not found or v_action.kind <> 'email.send' then
    raise exception 'Unknown customer email.' using errcode = 'P0002';
  end if;
  if v_action.status <> 'executing' or (p_execution is not null and v_action.executions <> p_execution) then
    raise exception 'That email is not being sent.' using errcode = '55000';
  end if;
  select e.status into v_recorded from private.agent_lifecycle_emails e where e.action_id = p_action_id;
  if found then
    return jsonb_build_object('state', 'recorded', 'status', v_recorded);
  end if;
  if p_unsubscribe_hash is null then
    return jsonb_build_object('state', 'unrecorded');
  end if;
  -- Nobody approved it: the Account Manager must still be active and trusted with this template, now.
  if v_action.decided_by is null then
    select * into v_agent from private.agents where key = v_action.agent_key for share;
    if v_agent.status is distinct from 'active' or v_agent.autonomy is distinct from 'act' or jsonb_typeof(v_agent.config -> 'auto_send_templates') is distinct from 'array'
      or not ((v_agent.config -> 'auto_send_templates') ? (v_action.input ->> 'template')) then
      return jsonb_build_object('state', 'auto_send_off');
    end if;
  end if;
  select livemode into v_live from private.billing_settings;
  select btrim(c.email), c.tenant_id into v_email, v_tenant
  from private.billing_customers c join hub.tenants t on t.id = c.tenant_id
  where t.slug = v_action.target_id and not c.deleted and c.livemode and coalesce(v_live, true);
  if v_email is null or v_email !~ '^[^[:space:]@<>"]+@[^[:space:]@<>"]+\.[^[:space:]@<>"]+$' or char_length(v_email) > 320 then
    return jsonb_build_object('state', 'no_address');
  end if;
  if private.growth_internal_address(v_email)
    or exists (select 1 from private.growth_organizations g where g.tenant_id = v_tenant and g.internal) then
    return jsonb_build_object('state', 'suppressed');
  end if;
  v_hash := private.email_hash(v_email);
  if exists (select 1 from private.email_suppressions x where x.email_hash = v_hash) then
    return jsonb_build_object('state', 'suppressed');
  end if;
  if exists (select 1 from private.growth_messages m join private.growth_contacts c on c.id = m.contact_id
    where c.email = lower(btrim(v_email)) and m.attempted_at > now() - make_interval(hours => (select max(min_gap_hours) from private.growth_policies))) then
    return jsonb_build_object('state', 'frequency_limited');
  end if;
  -- The cap is counted and taken one send at a time, so two servers cannot both take the twentieth.
  perform pg_advisory_xact_lock(hashtextextended('private.agent_lifecycle_emails', 0));
  if (select count(*) from private.agent_lifecycle_emails e
      where e.created_at >= private.agent_day_start() and e.status in ('sending', 'sent', 'unknown')) >= 20 then
    return jsonb_build_object('state', 'daily_limit');
  end if;
  insert into private.agent_lifecycle_emails (action_id, period_key, template, email_hash, unsubscribe_hash)
  values (v_action.id, v_action.input ->> 'periodKey', v_action.input ->> 'template', v_hash, p_unsubscribe_hash);
  return jsonb_build_object('state', 'ready', 'to', v_email);
end;
$$;
revoke all on function private.agent_lifecycle_begin_send(uuid, integer, text) from public, anon, authenticated, service_role;
grant execute on function private.agent_lifecycle_begin_send(uuid, integer, text) to hub_app_server;

do $$
declare
  d text;
begin
  d := pg_get_functiondef('private.growth_strategy_facts_json(timestamptz,timestamptz)'::regprocedure);
  if position('private.growth_internal_address(bc.email)' in d) = 0 then
    if position($q$and not exists (select 1 from private.growth_trial_cards c where c.stripe_subscription_id = s.stripe_subscription_id)
         and not exists (select 1 from private.growth_organizations g where g.tenant_id = s.tenant_id and g.internal)),$q$ in d) = 0 then
      raise exception 'The strategist''s no-card query changed; update this migration' using errcode = '55000';
    end if;
    execute replace(d,
      $q$and not exists (select 1 from private.growth_trial_cards c where c.stripe_subscription_id = s.stripe_subscription_id)
         and not exists (select 1 from private.growth_organizations g where g.tenant_id = s.tenant_id and g.internal)),$q$,
      $q$and not exists (select 1 from private.growth_trial_cards c where c.stripe_subscription_id = s.stripe_subscription_id)
         and not exists (select 1 from private.growth_organizations g where g.tenant_id = s.tenant_id and g.internal)
         and not exists (select 1 from private.billing_customers bc where bc.tenant_id = s.tenant_id and not bc.deleted and bc.livemode and private.growth_internal_address(bc.email))),$q$);
  end if;

  d := pg_get_functiondef('private.sales_growth_context_read(uuid,uuid)'::regprocedure);
  if position('''demo'', ''nurture'', ''trial'')' in d) = 0 then
    if position('and o.stage in (''identified'', ''researched'', ''qualified'', ''contacted'', ''engaged'', ''demo'', ''nurture'')' in d) = 0 then
      raise exception 'The Sales growth context changed; update this migration' using errcode = '55000';
    end if;
    execute replace(d, 'and o.stage in (''identified'', ''researched'', ''qualified'', ''contacted'', ''engaged'', ''demo'', ''nurture'')',
      'and o.stage in (''identified'', ''researched'', ''qualified'', ''contacted'', ''engaged'', ''demo'', ''nurture'', ''trial'')');
  end if;
end $$;
revoke all on function private.growth_strategy_facts_json(timestamptz, timestamptz) from public, anon, authenticated, service_role, hub_app_server;
revoke all on function private.sales_growth_context_read(uuid, uuid) from public, anon, authenticated, service_role, hub_app_server;
