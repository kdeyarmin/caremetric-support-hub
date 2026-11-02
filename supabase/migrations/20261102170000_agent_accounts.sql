-- The Account Manager: the AI team's fifth agent. Every Monday morning it reads the Hub's own billing mirror, the applications'
-- usage reports and the support cases, scores how each account is doing, and emails the owner who needs attention. It uses no
-- model, sends nothing to customers, and never reads a product's own data, so it needs no owner session. Like every agent it
-- starts paused and in Observe: nothing runs until the owner resumes it on the AI team page.
--
-- The schedule fires every morning at 07:15 Eastern, and the server's handler sends one report a week (every run in an Eastern
-- week uses the same alert key, so only the first sends), so a server that was down on Monday still reports on the next run.
-- Seeding is idempotent, and a row the owner already changed is left as it is.
insert into private.agents (key, display_name, role_summary, status, autonomy, model_tier, daily_budget_cents, tool_allowlist, config)
values ('account_manager', 'Account Manager',
  'Reads the Hub''s own billing mirror, the applications'' usage reports and the support cases, scores how each account is doing, and emails you every Monday who needs attention. Sends nothing to customers.',
  'paused', 'observe', 'fast', 50, array['get_accounts', 'notify_owner'], '{"effort": "low", "auto_approve_kinds": []}'::jsonb)
on conflict (key) do nothing;

insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('account_manager', 'accounts.weekly', 'daily', null, '07:15', 'America/New_York', false,
  private.agent_schedule_next('daily', null, '07:15', 'America/New_York', now(), null))
on conflict (agent_key, task_kind) do nothing;

-- ---------------------------------------------------------------------------------------
-- What the report reads. Two internal helpers (no role may execute them directly) and one
-- server operation. The facts are projected by whitelist: nothing is removed from a wider
-- view, so a column added to the billing mirror later cannot leak into the snapshot. No
-- billing contact address or name and no Stripe customer, subscription, invoice or item
-- identifier is returned; "hasEmail" says only whether an address exists. The catalog's
-- product and coupon identifiers stay, because the revenue maths matches discounts to items
-- by them.
-- ---------------------------------------------------------------------------------------

-- One subscription, as the Billing screen's own view renders it, cut down to what the money maths and the health score read.
create function private.agent_subscription_facts(s private.billing_subscriptions) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'app', v -> 'app', 'status', v -> 'status', 'collection_method', v -> 'collection_method',
    'cancel_at_period_end', v -> 'cancel_at_period_end', 'cancel_at', v -> 'cancel_at', 'canceled_at', v -> 'canceled_at', 'ended_at', v -> 'ended_at',
    'current_period_end', v -> 'current_period_end', 'trial_end', v -> 'trial_end', 'created', v -> 'created',
    'discounts', coalesce((select jsonb_agg(jsonb_build_object('coupon', d -> 'coupon')) from jsonb_array_elements(v -> 'discounts') d), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'product', i -> 'product', 'quantity', i -> 'quantity', 'unit_amount', i -> 'unit_amount', 'currency', i -> 'currency',
        'interval', i -> 'interval', 'interval_count', i -> 'interval_count', 'kind', i -> 'kind'))
      from jsonb_array_elements(v -> 'items') i), '[]'::jsonb))
  from (select private.billing_subscription_view(s) as v) x;
$$;

-- Every account (a tenant with a Stripe customer or a subscription), up to p_limit, by name. The Stripe mode filter is the
-- Billing workspace's: the verified mode, or everything while the mode is still unverified (the answer says which).
create function private.agent_accounts_json(p_limit integer) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_live boolean;
  v_total integer;
begin
  select livemode into v_live from private.billing_settings;
  select count(*)::integer into v_total from hub.tenants t
  where exists (select 1 from private.billing_customers c where c.tenant_id = t.id and not c.deleted and (v_live is null or c.livemode = v_live))
     or exists (select 1 from private.billing_subscriptions s where s.tenant_id = t.id and (v_live is null or s.livemode = v_live));
  return jsonb_build_object(
    'generatedAt', now(),
    'mode', case when v_live is null then 'unverified' when v_live then 'live' else 'test' end,
    'total', v_total,
    'truncated', v_total > p_limit,
    'coupons', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.stripe_coupon_id, 'percent_off', c.percent_off, 'amount_off', c.amount_off, 'applies_to', to_jsonb(c.applies_to_products)) order by c.stripe_coupon_id), '[]'::jsonb)
      from private.billing_coupons c where not c.deleted and (v_live is null or c.livemode = v_live)),
    'accounts', (select coalesce(jsonb_agg(a.account order by a.name, a.id), '[]'::jsonb) from (
      select t.id, t.name, jsonb_build_object(
        'slug', t.slug, 'name', t.name, 'status', t.status, 'createdAt', t.created_at,
        'products', (select coalesce(jsonb_agg(jsonb_build_object('slug', p.slug, 'planCode', tp.plan_code, 'status', tp.status) order by p.slug), '[]'::jsonb)
          from hub.tenant_products tp join hub.products p on p.id = tp.product_id where tp.tenant_id = t.id and p.status <> 'retired'),
        'customer', (select jsonb_build_object('delinquent', c.delinquent, 'balanceCents', c.balance, 'hasEmail', char_length(btrim(c.email)) > 0)
          from private.billing_customers c where c.tenant_id = t.id and not c.deleted and (v_live is null or c.livemode = v_live)),
        'subscriptions', (select coalesce(jsonb_agg(private.agent_subscription_facts(s) order by s.stripe_created desc), '[]'::jsonb)
          from private.billing_subscriptions s where s.tenant_id = t.id and (v_live is null or s.livemode = v_live)),
        -- An open invoice is overdue three days after its due date, or after it was created when it has none (a card payment Stripe is still retrying).
        'invoices', (select jsonb_build_object(
            'open', count(*) filter (where i.status = 'open'),
            'overdue', count(*) filter (where i.status = 'open' and coalesce(i.due_date, i.stripe_created) < now() - interval '3 days'),
            'remainingCents', coalesce(sum(i.amount_remaining) filter (where i.status = 'open'), 0)::bigint,
            'oldestOverdueDue', min(coalesce(i.due_date, i.stripe_created)) filter (where i.status = 'open' and coalesce(i.due_date, i.stripe_created) < now() - interval '3 days'),
            'latestPaidAt', max(i.stripe_created) filter (where i.status = 'paid'))
          from private.billing_invoices i where i.tenant_id = t.id and (v_live is null or i.livemode = v_live)),
        -- What the applications themselves report: per product and metric, the newest quantity and the newest one at or before 28 days earlier.
        'usage', (select coalesce(jsonb_agg(jsonb_build_object(
            'app', pr.slug, 'metric', u.metric, 'latest', u.quantity, 'latestAt', u.reported_at, 'baseline', b.quantity, 'baselineAt', b.reported_at)
            order by pr.slug, u.metric), '[]'::jsonb)
          from (select distinct on (r.product_id, r.metric) r.tenant_id, r.product_id, r.metric, r.quantity, r.reported_at
                from private.billing_usage_reports r where r.tenant_id = t.id order by r.product_id, r.metric, r.reported_at desc) u
          join hub.products pr on pr.id = u.product_id and pr.status <> 'retired'
          left join lateral (select x.quantity, x.reported_at from private.billing_usage_reports x
                where x.tenant_id = u.tenant_id and x.product_id = u.product_id and x.metric = u.metric and x.reported_at <= now() - interval '28 days'
                order by x.reported_at desc limit 1) b on true),
        -- Numbers only: never a subject, a requester or a message.
        'cases', (select jsonb_build_object(
            'waitingOnYou', count(*) filter (where c.status in ('open', 'in_progress')),
            'highOrUrgent', count(*) filter (where c.status in ('open', 'in_progress') and c.priority in ('high', 'urgent')),
            'waitingOnCustomer', count(*) filter (where c.status = 'waiting_on_customer'),
            'oldestOpenAt', min(c.created_at) filter (where c.status in ('open', 'in_progress')))
          from hub.support_cases c join hub.products cp on cp.id = c.product_id and cp.status <> 'retired' where c.tenant_id = t.id)
      ) as account
      from hub.tenants t
      where exists (select 1 from private.billing_customers c where c.tenant_id = t.id and not c.deleted and (v_live is null or c.livemode = v_live))
         or exists (select 1 from private.billing_subscriptions s where s.tenant_id = t.id and (v_live is null or s.livemode = v_live))
      order by t.name, t.id
      limit p_limit) a));
end;
$$;

-- The server operation. Refuses every session user except hub_app_server, then answers.
create function private.agent_accounts_snapshot(p_limit integer default 200) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'Choose a limit between 1 and 500.' using errcode = '22023';
  end if;
  return private.agent_accounts_json(p_limit);
end;
$$;

revoke all on function private.agent_subscription_facts(private.billing_subscriptions), private.agent_accounts_json(integer),
  private.agent_accounts_snapshot(integer) from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.agent_accounts_snapshot(integer) to hub_app_server;
