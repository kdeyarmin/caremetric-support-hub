-- Keep the first customers (AI workforce review 2026-11-17, team review, stage 4; docs/AI_WORKFORCE_REVIEW_2026-11-17_TEAM.md).
--
-- 1. An Intel trial starts when Stripe confirms its card. Intel opens a trial when someone opens card setup, before any card exists,
--    so a trialing subscription alone proves nothing (20261116020000_billing_trial_cards.sql). The billing mirror no longer queues
--    `trial_started` for an Intel subscription; the first confirmation of its card does (private.growth_trial_cards keeps when that
--    was, and outlives the trial, which billing_trial_cards does not). CareBase, which needs no card, is unchanged.
-- 2. A trial that ends unpaid reaches growth as `churned`, once, if its start was counted; an extended trial's new end date reaches
--    the opportunity.
-- 3. Three more customer emails: `card_reminder` (an Intel sign-up whose card was never confirmed), `midtrial_nudge` (days 10 to 16
--    with no first value) and `value_followup` (days 10 to 16 after first value). The action, ledger and period checks accept them.
-- 4. private.agent_lifecycle_json (same signature; no role may run it) reports, per account and product, when the trial's card was
--    first confirmed, the product's last activity and first value events, and whether the trial chose its county.
-- 5. private.agent_lifecycle_defer: a customer email the send claim refused for the day's cap or the growth contact gap waits and is
--    tried again (before, the refusal ended it, and the template was never proposed again: a prospect who signed up within three
--    days of a cold email never got a welcome).
-- 6. The Sales Executive's hand-over includes a prospect in its trial.
-- 7. Intel's activity events may report three milestones as `active` events: county_chosen, agency_saved and activated.
--
-- 20261117230100_trial_path_contract.sql declares platform.agents.trial-path.v1; the Hub uses all of this only then.
set local lock_timeout = '10s';

-- 1. When each Intel trial's card was first confirmed. --------------------------------------------------------------------------------
create table if not exists private.growth_trial_cards (
  stripe_subscription_id text primary key,
  tenant_id uuid not null references hub.tenants(id) on delete cascade,
  first_confirmed_at timestamptz not null default now()
);
alter table private.growth_trial_cards enable row level security;
revoke all on private.growth_trial_cards from public, anon, authenticated, service_role, hub_app_server;

alter table private.growth_billing_outbox drop constraint if exists growth_billing_outbox_kind_check;
alter table private.growth_billing_outbox add constraint growth_billing_outbox_kind_check check (kind in ('trial_started', 'paid', 'churned'));

-- A card confirmed for a live Intel trial: remembered once, and the trial's start queued for growth (once, under the same key the
-- mirror used before, so a trial queued earlier is never counted twice).
create or replace function private.growth_trial_card_seen() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_sub private.billing_subscriptions; v_product text;
begin
  select * into v_sub from private.billing_subscriptions where stripe_subscription_id = new.stripe_subscription_id;
  if not found or not v_sub.livemode or v_sub.tenant_id is distinct from new.tenant_id then return new; end if;
  select slug into v_product from hub.products where id = v_sub.product_id;
  if v_product is distinct from 'caremetric-intel' then return new; end if;
  insert into private.growth_trial_cards (stripe_subscription_id, tenant_id, first_confirmed_at)
  values (new.stripe_subscription_id, new.tenant_id, now()) on conflict (stripe_subscription_id) do nothing;
  if v_sub.status = 'trialing' and v_sub.trial_start is not null and v_sub.trial_start >= (select started_at from private.growth_lifecycle_start) then
    insert into private.growth_billing_outbox (event_key, tenant_id, product, kind, subscription_id, occurred_at, facts)
    values ('billing:trial:' || v_sub.stripe_subscription_id, v_sub.tenant_id, v_product, 'trial_started', v_sub.stripe_subscription_id, now(),
      jsonb_strip_nulls(jsonb_build_object('trialEnd', v_sub.trial_end)))
    on conflict do nothing;
  end if;
  return new;
end; $$;
revoke all on function private.growth_trial_card_seen() from public, anon, authenticated, service_role, hub_app_server;
drop trigger if exists growth_trial_card_seen on private.billing_trial_cards;
create trigger growth_trial_card_seen after insert or update on private.billing_trial_cards
  for each row execute function private.growth_trial_card_seen();
-- Cards already confirmed (their trials were queued by the mirror, so only the date is kept).
insert into private.growth_trial_cards (stripe_subscription_id, tenant_id, first_confirmed_at)
select c.stripe_subscription_id, c.tenant_id, c.confirmed_at from private.billing_trial_cards c
on conflict (stripe_subscription_id) do nothing;

-- 1 and 2. The billing mirror's capture: unchanged except where marked.
create or replace function private.growth_capture_billing() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_product text; invoice private.billing_invoices;begin
 if not new.livemode then return new;end if;
 if tg_table_name='billing_invoices' then
  perform private.growth_queue_paid(new,case when tg_op='INSERT' then true else old.status='paid' and old.amount_paid>0 end);
  return new;
 end if;
 select slug into v_product from hub.products where id=new.product_id;
 if v_product is null or v_product not in ('carebase','caremetric-intel') then return new;end if;
 -- Webhooks can deliver a paid invoice before its subscription or product binding. Revisit recent, already paid invoices
 -- when the authoritative subscription arrives, without changing the mirrored invoice or inventing a payment timestamp.
 for invoice in select * from private.billing_invoices where stripe_subscription_id=new.stripe_subscription_id
  and status='paid' and amount_paid>0 and stripe_created>=(select started_at from private.growth_lifecycle_start)
  order by stripe_created limit 10 loop
  perform private.growth_queue_paid(invoice,true);
 end loop;
 -- Trial path (20261117230000_trial_path.sql): an Intel trial starts when its card is confirmed (private.growth_trial_card_seen).
 if new.status='trialing' and new.trial_start is not null and new.trial_start>=(select started_at from private.growth_lifecycle_start)
  and v_product<>'caremetric-intel' then
  insert into private.growth_billing_outbox(event_key,tenant_id,product,kind,subscription_id,occurred_at,facts)
  values('billing:trial:'||new.stripe_subscription_id,new.tenant_id,v_product,'trial_started',new.stripe_subscription_id,new.trial_start,
    jsonb_strip_nulls(jsonb_build_object('trialEnd',new.trial_end))) on conflict do nothing;
 end if;
 -- Trial path: a counted trial that ended with nothing ever paid on it is lost, once.
 if tg_op='UPDATE' and old.status='trialing' and new.status in ('canceled','incomplete_expired','paused')
  and exists(select 1 from private.growth_billing_outbox b where b.event_key='billing:trial:'||new.stripe_subscription_id)
  and not exists(select 1 from private.billing_invoices i where i.stripe_subscription_id=new.stripe_subscription_id and i.status='paid' and i.amount_paid>0) then
  insert into private.growth_billing_outbox(event_key,tenant_id,product,kind,subscription_id,occurred_at)
  values('billing:trial_lost:'||new.stripe_subscription_id,new.tenant_id,v_product,'churned',new.stripe_subscription_id,now()) on conflict do nothing;
 end if;
 -- Trial path: an extended (or shortened) trial's end reaches the opportunity it belongs to.
 if tg_op='UPDATE' and new.status='trialing' and new.trial_end is distinct from old.trial_end and new.trial_end is not null then
  update private.growth_opportunities o set trial_end=new.trial_end,updated_at=now()
   from private.growth_organizations g
   where g.tenant_id=new.tenant_id and o.organization_id=g.id and o.product=v_product and o.stage='trial' and o.trial_end is distinct from new.trial_end;
 end if;
 return new;
end;$$;
revoke all on function private.growth_capture_billing() from public,anon,authenticated,service_role,hub_app_server;

-- 3. The three new customer emails, in every check. ----------------------------------------------------------------------------------
alter table private.agent_actions drop constraint agent_actions_email_send_check;
alter table private.agent_actions add constraint agent_actions_email_send_check check (
  kind <> 'email.send' or coalesce(
    target_kind = 'billing_account'
    and (input - array['template', 'tenant', 'tenantName', 'product', 'productName', 'helpUrl', 'bookingUrl', 'periodKey', 'textHash']) = '{}'::jsonb
    and input ->> 'template' in ('welcome', 'setup_nudge', 'trial_checkin', 'testimonial_ask', 'cancel_save', 'trial_ended',
      'card_reminder', 'midtrial_nudge', 'value_followup')
    and target_id = input ->> 'tenant'
    and target_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    and coalesce(input ->> 'product', '') ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    and input ->> 'periodKey' = 'account:' || (input ->> 'template') || ':' || target_id || ':' || (input ->> 'product')
    and coalesce(input ->> 'textHash', '') ~ '^[0-9a-f]{64}$'
    and coalesce(input ->> 'helpUrl', '') ~ '^https://[^[:space:]"<>]+$' and char_length(input ->> 'helpUrl') <= 308
    and (jsonb_typeof(input -> 'bookingUrl') = 'null'
      or (coalesce(input ->> 'bookingUrl', '') ~ '^https://[^[:space:]"<>]+$' and char_length(input ->> 'bookingUrl') <= 308))
    and char_length(coalesce(input ->> 'tenantName', '')) between 1 and 200
    and char_length(coalesce(input ->> 'productName', '')) between 1 and 120, false));

alter table private.agent_lifecycle_emails drop constraint if exists agent_lifecycle_emails_template_check,
  drop constraint if exists agent_lifecycle_emails_period_key_check;
alter table private.agent_lifecycle_emails
  add constraint agent_lifecycle_emails_template_check
    check (template in ('welcome', 'setup_nudge', 'trial_checkin', 'testimonial_ask', 'cancel_save', 'trial_ended',
      'card_reminder', 'midtrial_nudge', 'value_followup')),
  add constraint agent_lifecycle_emails_period_key_check
    check (period_key ~ '^account:(welcome|setup_nudge|trial_checkin|testimonial_ask|cancel_save|trial_ended|card_reminder|midtrial_nudge|value_followup):[a-z0-9]+(-[a-z0-9]+)*:[a-z0-9]+(-[a-z0-9]+)*$');

-- 4. The Account Manager's facts: as 20261113300000_lifecycle_save.sql, plus the trial path's facts (marked). ---------------------------
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

-- 5. A refused customer email waits instead of ending. ---------------------------------------------------------------------------------
-- Server: the send claim refused it for the day's cap (it waits for 9 AM Eastern the next day) or for the growth contact gap (it waits a
-- day). The executor checks the account again when it is tried, so an email that no longer fits is still refused then.
create or replace function private.agent_lifecycle_defer(p_id uuid, p_execution integer, p_reason text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_at timestamptz; v_deferred boolean;
begin
  perform private.require_hub_app_server();
  if p_reason = 'daily_limit' then
    v_at := (date_trunc('day', now() at time zone 'America/New_York') + interval '1 day 9 hours') at time zone 'America/New_York';
  elsif p_reason = 'frequency_limited' then
    v_at := now() + interval '1 day';
  else
    return false;
  end if;
  update private.agent_actions set status = case when decided_by is null then 'auto_approved' else 'approved' end,
    executing_at = null, not_before = v_at, updated_at = now()
   where id = p_id and kind = 'email.send' and status = 'executing' and executions = p_execution
  returning true into v_deferred;
  return coalesce(v_deferred, false);
end; $$;
revoke all on function private.agent_lifecycle_defer(uuid, integer, text) from public, anon, authenticated, service_role;
grant execute on function private.agent_lifecycle_defer(uuid, integer, text) to hub_app_server;

-- 6 and 7. Two patches in place, each refused if the text it replaces has changed. -----------------------------------------------------
do $$
declare d text;
begin
  d := pg_get_functiondef('private.sales_handoff(uuid,uuid)'::regprocedure);
  if position('''demo'', ''nurture'', ''trial'')' in d) = 0 then
    if position('and o.stage in (''identified'', ''researched'', ''qualified'', ''contacted'', ''engaged'', ''demo'', ''nurture'')' in d) = 0 then
      raise exception 'The Sales hand-over changed; update this migration' using errcode = '55000';
    end if;
    execute replace(d, 'and o.stage in (''identified'', ''researched'', ''qualified'', ''contacted'', ''engaged'', ''demo'', ''nurture'')',
      'and o.stage in (''identified'', ''researched'', ''qualified'', ''contacted'', ''engaged'', ''demo'', ''nurture'', ''trial'')');
  end if;
  d := pg_get_functiondef('private.growth_app_event(text,jsonb)'::regprocedure);
  if position('county_chosen' in d) = 0 then
    if position('(p_data->''facts'' ? ''metric'' and p_data->''facts''->>''metric''<>''provider_lists'')' in d) = 0 then
      raise exception 'The application activity check changed; update this migration' using errcode = '55000';
    end if;
    execute replace(d, '(p_data->''facts'' ? ''metric'' and p_data->''facts''->>''metric''<>''provider_lists'')',
      '(p_data->''facts'' ? ''metric'' and (p_data->''facts''->>''metric'' not in (''provider_lists'',''county_chosen'',''agency_saved'',''activated'')'
      || ' or (p_data->''facts''->>''metric''<>''provider_lists'' and p_data->>''kind''<>''active'')))');
  end if;
end $$;
