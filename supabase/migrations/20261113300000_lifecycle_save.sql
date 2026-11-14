-- Two more Account Manager customer emails (AI workforce review 2026-11-12, P2: "no churn-save, dunning or win-back exists").
--
-- - cancel_save  a trial or a paid plan the customer has set to cancel: what did not work, and how to tell us, by reply.
-- - trial_ended  a trial that ended in the last 14 days with no payment ever made for the product: thanks for trying, and what got
--                in the way, by reply.
--
-- Both are proposed for the owner's approval only (never in the autonomy steps' auto_send_templates), once per account and
-- product, and only while Settings -> Customer growth -> "Win-back and cancellation emails" is on (growth.save_emails, off until the
-- owner turns it on). Payment failures stay with Stripe's own emails, which the Hub never repeats.
--
-- 1. The setting row.
-- 2. agent_actions_email_send_check and the send ledger's template and period checks accept the two templates.
-- 3. private.agent_lifecycle_json (same signature; no role may run it) also returns a plan being cancelled, however long it was
--    paid for, and a trial that ended unpaid in the last 14 days (its subscription canceled, expired or paused, and no newer
--    subscription of any status since), and reports what became of the two new emails. Every other row and fact is unchanged.
--
-- 20261113300100_lifecycle_save_contract.sql declares platform.agents.lifecycle-save.v1; the Hub proposes the two emails only then.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.save_emails', 'flag')
on conflict (key) do nothing;

alter table private.agent_actions drop constraint agent_actions_email_send_check;
alter table private.agent_actions add constraint agent_actions_email_send_check check (
  kind <> 'email.send' or coalesce(
    target_kind = 'billing_account'
    and (input - array['template', 'tenant', 'tenantName', 'product', 'productName', 'helpUrl', 'bookingUrl', 'periodKey', 'textHash']) = '{}'::jsonb
    and input ->> 'template' in ('welcome', 'setup_nudge', 'trial_checkin', 'testimonial_ask', 'cancel_save', 'trial_ended')
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
    check (template in ('welcome', 'setup_nudge', 'trial_checkin', 'testimonial_ask', 'cancel_save', 'trial_ended')),
  add constraint agent_lifecycle_emails_period_key_check
    check (period_key ~ '^account:(welcome|setup_nudge|trial_checkin|testimonial_ask|cancel_save|trial_ended):[a-z0-9]+(-[a-z0-9]+)*:[a-z0-9]+(-[a-z0-9]+)*$');

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
        'emails', (select jsonb_object_agg(tpl, (select a.status from private.agent_actions a
              where a.kind = 'email.send' and a.input ->> 'periodKey' = 'account:' || tpl || ':' || t.slug || ':' || p.slug))
          from unnest(array['welcome', 'setup_nudge', 'trial_checkin', 'testimonial_ask', 'cancel_save', 'trial_ended']) tpl)) as fact
      from chosen ch
      join hub.tenants t on t.id = ch.tenant_id
      join hub.products p on p.id = ch.product_id
      left join contact ct on ct.tenant_id = ch.tenant_id
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
