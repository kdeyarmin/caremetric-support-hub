-- The Account Manager's customer emails. A trial that starts and hears nothing leaks: CareBase (30 days) and Intel (14 days)
-- trials get no welcome, no setup help and no personal check-in, and a CareBase trial without a card cancels silently. The
-- Account Manager now proposes four short, fixed emails to the billing contact of an account, each one at most once per
-- account and product:
--   * welcome          days 0 to 2 of a trial: what to do first, with the product's getting-started help;
--   * setup_nudge      days 3 to 6 of a trial, only while the product has reported no positive usage for the account: an offer
--                      of help;
--   * trial_checkin    when 5 days or fewer (and more than 2) are left in a trial: a personal check-in, not a billing notice;
--   * testimonial_ask  45 to 60 days after the account's first paid invoice for the product, with no open high or urgent case: a
--                      request for a sentence, with consent wording.
-- Stripe's own customer emails (a failed payment, a trial ending, receipts) stay on and are never duplicated here.
--
-- Every email is an action of the new kind email.send aimed at a billing_account (the tenant's slug). The owner approves the exact
-- text on the Team screen; an agent on Act sends on its own only the templates the owner lists in config.auto_send_templates
-- (listing the kind in auto_approve_kinds never does it). Nothing here sends: the Hub server sends an approved email through
-- SendGrid after asking the database, at that moment, for the one address it goes to.
--
-- Boundary (the same closed shape as the rest of the AI team):
--   * the new ledger table has row level security and no privilege for any browser, service or server role;
--   * the three new operations are security definers with a pinned empty search path that refuse every session user except
--     hub_app_server; their helper is executable by no role;
--   * no operation returns a billing address except the send-time lookup, which returns the one address of the one account an
--     approved email is being sent to, and records the send (by the address's SHA-256 hash, as bulk email does) before it answers;
--   * an action's input is a fixed whitelist of the facts that rebuild the email (names, links, the period key and a hash of the
--     wording), never an address.

-- ---------------------------------------------------------------------------------------
-- 1. The action kind and its target. The two checks are widened, never narrowed: every kind and target kind the table allows
--    today is kept (read from the constraints themselves, so a kind another change added before this one survives), and the
--    statement refuses to run if the kinds every server relies on cannot be read.
-- ---------------------------------------------------------------------------------------
do $$
declare
  v_kinds text[];
  v_targets text[];
begin
  select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_kinds
  from pg_constraint c cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') m
  where c.conrelid = 'private.agent_actions'::regclass and c.conname = 'agent_actions_kind_check';
  select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_targets
  from pg_constraint c cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') m
  where c.conrelid = 'private.agent_actions'::regclass and c.conname = 'agent_actions_target_kind_check';
  if not v_kinds @> array['communication.reply', 'communication.note', 'communication.update', 'incident.open', 'incident.resolve', 'import.run']
    or not v_targets @> array['communication', 'probe_target', 'import_source']
    or exists (select 1 from unnest(v_kinds || v_targets) value where value !~ '^[a-z][a-z0-9_.]{1,60}$') then
    raise exception 'The agent action kinds could not be read' using errcode = '55000';
  end if;
  execute format('alter table private.agent_actions drop constraint agent_actions_kind_check, add constraint agent_actions_kind_check check (kind in (%s))',
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_kinds || array['email.send']) as k) x));
  execute format('alter table private.agent_actions drop constraint agent_actions_target_kind_check, add constraint agent_actions_target_kind_check check (target_kind in (%s))',
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_targets || array['billing_account']) as k) x));
end $$;

-- A customer email carries exactly these facts and nothing else (no address can be among them), names its account by slug, and
-- is keyed by its period: account:<template>:<tenant>:<product>. One email per period, whichever task proposed it. A missing
-- fact fails the check (coalesce), rather than passing it as unknown.
alter table private.agent_actions add constraint agent_actions_email_send_check check (
  kind <> 'email.send' or coalesce(
    target_kind = 'billing_account'
    and (input - array['template', 'tenant', 'tenantName', 'product', 'productName', 'helpUrl', 'bookingUrl', 'periodKey', 'textHash']) = '{}'::jsonb
    and input ->> 'template' in ('welcome', 'setup_nudge', 'trial_checkin', 'testimonial_ask')
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
create unique index agent_actions_email_send_once on private.agent_actions ((input ->> 'periodKey')) where kind = 'email.send';

-- ---------------------------------------------------------------------------------------
-- 2. Proposals: the per-template rule for an agent trusted to act. Everything else is exactly the hardened operation
--    (20261102180000): the task is locked first, an observe-only agent cannot propose, and a retried task proposes once.
-- ---------------------------------------------------------------------------------------
create or replace function private.agent_action_propose(
  p_task_id uuid, p_run_id uuid, p_kind text, p_target_kind text, p_target_id text,
  p_preview text, p_input jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_task private.agent_tasks%rowtype;
  v_agent private.agents%rowtype;
  v_status text;
  v_id uuid;
  v_key uuid;
begin
  perform private.require_hub_app_server();
  select * into v_task from private.agent_tasks where id = p_task_id for update;
  if not found then
    raise exception 'Unknown agent task.' using errcode = 'P0002';
  end if;
  if v_task.status <> 'running' then
    raise exception 'Only a running task can propose an action.' using errcode = '55000';
  end if;
  if p_run_id is not null and not exists (select 1 from private.agent_runs r where r.id = p_run_id and r.task_id = p_task_id) then
    raise exception 'That run does not belong to this task.' using errcode = '55000';
  end if;
  select * into v_agent from private.agents where key = v_task.agent_key;
  if v_agent.autonomy = 'observe' then
    raise exception 'This agent is observe-only and cannot propose actions.' using errcode = '42501';
  end if;
  v_status := case
    when v_agent.autonomy <> 'act' then 'proposed'
    -- A customer email is approved on its own only when the owner listed its template in auto_send_templates. Listing the kind in
    -- auto_approve_kinds never approves one, so an agent trusted with one template can never send the others unseen.
    when p_kind = 'email.send' then case
      when jsonb_typeof(v_agent.config -> 'auto_send_templates') = 'array'
        and (v_agent.config -> 'auto_send_templates') ? coalesce(p_input ->> 'template', '') then 'auto_approved'
      else 'proposed' end
    when coalesce(v_agent.config -> 'auto_approve_kinds', '[]'::jsonb) ? p_kind then 'auto_approved'
    else 'proposed' end;
  insert into private.agent_actions (task_id, run_id, agent_key, kind, target_kind, target_id, preview, input, status)
  values (p_task_id, p_run_id, v_task.agent_key, p_kind, p_target_kind, coalesce(p_target_id, ''), p_preview,
          coalesce(p_input, '{}'::jsonb), v_status)
  on conflict (task_id, kind, target_id) where task_id is not null do nothing
  returning id, request_key into v_id, v_key;
  if v_id is null then
    select a.id, a.request_key, a.status into v_id, v_key, v_status
    from private.agent_actions a
    where a.task_id = p_task_id and a.kind = p_kind and a.target_id = coalesce(p_target_id, '');
    return jsonb_build_object('id', v_id, 'status', v_status, 'requestKey', v_key, 'created', false);
  end if;
  return jsonb_build_object('id', v_id, 'status', v_status, 'requestKey', v_key, 'created', true);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- 3. The send ledger. A send is recorded here, under its action, before SendGrid is asked, so an execution that is started again
--    (the server stopped mid-send and the sweep handed the action back) finds it and never sends twice. The address is kept only as
--    the same SHA-256 hash bulk email keeps (private.email_hash), for the suppression list and the personal unsubscribe link, whose
--    own token is kept only as a hash too. The day's sends are counted from here, for the cap of 20 a day across every account.
-- ---------------------------------------------------------------------------------------
create table private.agent_lifecycle_emails (
  action_id uuid primary key references private.agent_actions(id) on delete cascade,
  period_key text not null unique check (period_key ~ '^account:(welcome|setup_nudge|trial_checkin|testimonial_ask):[a-z0-9]+(-[a-z0-9]+)*:[a-z0-9]+(-[a-z0-9]+)*$'),
  template text not null check (template in ('welcome', 'setup_nudge', 'trial_checkin', 'testimonial_ask')),
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  unsubscribe_hash text not null unique check (unsubscribe_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed', 'unknown')),
  provider_message_id text check (char_length(provider_message_id) <= 200),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  check ((status = 'sending') = (finished_at is null))
);
create index agent_lifecycle_emails_day on private.agent_lifecycle_emails (created_at);
alter table private.agent_lifecycle_emails enable row level security;
revoke all on private.agent_lifecycle_emails from public, anon, authenticated, service_role, hub_app_server;
comment on table private.agent_lifecycle_emails is
  'Customer emails from the Account Manager, recorded before each send. The address is kept only as its SHA-256 hash; the body is never kept here.';

-- ---------------------------------------------------------------------------------------
-- 4. What the templates read. One row per account and product with a live trial, or a live paid subscription whose account first
--    paid for the product at most 90 days ago. The first payment is the earliest paid invoice of any live subscription the account
--    ever had for the product, historical ones included, so replacing a subscription neither postpones the testimonial request nor
--    makes an established account look newly paying. The Stripe mode rule is the Billing workspace's (the verified mode, or
--    everything while it is unverified), narrowed to live-mode records: nothing from Stripe's test mode ever reaches a customer, and
--    while the verified mode is test there is nothing at all. Facts are projected by whitelist; "hasEmail" and "suppressed" say only
--    whether a usable address exists and whether it unsubscribed, never what it is. "hasUsage" counts only a report of a positive
--    quantity (the usage API accepts zero, which is no usage). "emails" is what became of each template's email for this account
--    and product (the action's status), read by its period key, or null when none was ever proposed. Rows come newest first, a
--    page at a time (p_limit rows from p_offset), and "truncated" says more rows follow the page: the Hub server reads several
--    pages and plans them together, so a limit never decides which account gets its email.
-- ---------------------------------------------------------------------------------------
create function private.agent_lifecycle_json(p_limit integer, p_tenant text, p_product text, p_offset integer) returns jsonb
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
      where s.livemode and coalesce(v_live, true) and s.status in ('trialing', 'active')
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
          from unnest(array['welcome', 'setup_nudge', 'trial_checkin', 'testimonial_ask']) tpl)) as fact
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

create function private.agent_lifecycle_snapshot(p_limit integer default 200, p_tenant text default null, p_product text default null, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'Choose a limit between 1 and 500.' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 10000 then
    raise exception 'Choose an offset between 0 and 10000.' using errcode = '22023';
  end if;
  if (p_tenant is not null and p_tenant !~ '^[a-z0-9]+(-[a-z0-9]+)*$') or (p_product is not null and p_product !~ '^[a-z0-9]+(-[a-z0-9]+)*$') then
    raise exception 'Choose an account and a product by their keys.' using errcode = '22023';
  end if;
  return private.agent_lifecycle_json(p_limit, p_tenant, p_product, p_offset);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- 5. Sending one approved email. The send-time lookup is the only operation that returns a billing address: the one address of
--    the account the email is aimed at, for the execution that is carrying the action out right now. Before answering it refuses an
--    email that was approved on its own but whose template the owner no longer lists (or whose agent no longer acts), an account
--    with no usable address, an address that unsubscribed (the bulk email suppression list), and a day that already reached its 20
--    sends; then it records the send. An action that already has a send recorded is never answered with an address again: the
--    caller settles what the record says. Called with no unsubscribe hash, it only says whether a send was recorded for this
--    execution's action ('recorded' with its status, or 'unrecorded') and changes nothing, so a sender that stopped mid-send is
--    settled from its record before anything else is judged.
-- ---------------------------------------------------------------------------------------
create function private.agent_lifecycle_begin_send(p_action_id uuid, p_execution integer, p_unsubscribe_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_agent private.agents%rowtype;
  v_recorded text;
  v_live boolean;
  v_email text;
  v_hash text;
begin
  perform private.require_hub_app_server();
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
  if v_action.decided_by is null then
    select * into v_agent from private.agents where key = v_action.agent_key;
    if v_agent.autonomy is distinct from 'act' or jsonb_typeof(v_agent.config -> 'auto_send_templates') is distinct from 'array'
      or not ((v_agent.config -> 'auto_send_templates') ? (v_action.input ->> 'template')) then
      return jsonb_build_object('state', 'auto_send_off');
    end if;
  end if;
  select livemode into v_live from private.billing_settings;
  select btrim(c.email) into v_email
  from private.billing_customers c join hub.tenants t on t.id = c.tenant_id
  where t.slug = v_action.target_id and not c.deleted and c.livemode and coalesce(v_live, true);
  if v_email is null or v_email !~ '^[^[:space:]@<>"]+@[^[:space:]@<>"]+\.[^[:space:]@<>"]+$' or char_length(v_email) > 320 then
    return jsonb_build_object('state', 'no_address');
  end if;
  v_hash := private.email_hash(v_email);
  if exists (select 1 from private.email_suppressions x where x.email_hash = v_hash) then
    return jsonb_build_object('state', 'suppressed');
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

-- What SendGrid answered for one recorded send.
create function private.agent_lifecycle_finish_send(p_action_id uuid, p_delivery text, p_provider_message_id text default null) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_delivery is null or p_delivery not in ('sent', 'failed', 'unknown') or char_length(p_provider_message_id) > 200 then
    raise exception 'Invalid delivery outcome.' using errcode = '22023';
  end if;
  update private.agent_lifecycle_emails
  set status = p_delivery, provider_message_id = p_provider_message_id, finished_at = now()
  where action_id = p_action_id and status = 'sending';
  return found;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- 6. One unsubscribe page and one suppression list for both kinds of email. A bulk email link works exactly as before; a link from
--    a customer email is looked up by its own token hash and, once confirmed, suppresses the same address hash in the same list.
--    Looking a link up changes nothing, so a link scanner unsubscribes nobody. The answer says which kind of email it came from, so
--    the page can say so; the suppression stops both kinds.
-- ---------------------------------------------------------------------------------------
create or replace function private.email_unsubscribe(p_token_hash text, p_confirm boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare recipient private.email_recipients; lifecycle private.agent_lifecycle_emails; v_added integer;
begin
  if session_user <> 'hub_app_server' then raise exception 'Application server required.' using errcode = '42501'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('valid', false); end if;
  select * into recipient from private.email_recipients where unsubscribe_hash = p_token_hash;
  if found then
    if p_confirm then
      insert into private.email_suppressions(email_hash, campaign_id) values (recipient.email_hash, recipient.campaign_id) on conflict do nothing;
      get diagnostics v_added = row_count;
      if v_added > 0 then
        insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
          values (null, 'email_campaign.unsubscribe', 'email_campaign', recipient.campaign_id, '{}'::jsonb);
      end if;
    end if;
    return jsonb_build_object('valid', true, 'purpose', 'announcements',
      'unsubscribed', exists (select 1 from private.email_suppressions where email_hash = recipient.email_hash));
  end if;
  select * into lifecycle from private.agent_lifecycle_emails where unsubscribe_hash = p_token_hash;
  if not found then return jsonb_build_object('valid', false); end if;
  if p_confirm then
    insert into private.email_suppressions(email_hash) values (lifecycle.email_hash) on conflict do nothing;
    get diagnostics v_added = row_count;
    if v_added > 0 then
      insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
        values (null, 'agent.email.unsubscribe', 'agent_action', lifecycle.action_id, jsonb_build_object('template', lifecycle.template));
    end if;
  end if;
  return jsonb_build_object('valid', true, 'purpose', 'lifecycle',
    'unsubscribed', exists (select 1 from private.email_suppressions where email_hash = lifecycle.email_hash));
end;
$$;

revoke all on function private.agent_lifecycle_json(integer, text, text, integer), private.agent_lifecycle_snapshot(integer, text, text, integer),
  private.agent_lifecycle_begin_send(uuid, integer, text), private.agent_lifecycle_finish_send(uuid, text, text)
  from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.agent_lifecycle_snapshot(integer, text, text, integer), private.agent_lifecycle_begin_send(uuid, integer, text),
  private.agent_lifecycle_finish_send(uuid, text, text) to hub_app_server;
-- The two replaced operations keep their grants; restate them so this file alone says who may call them.
revoke all on function private.agent_action_propose(uuid, uuid, text, text, text, text, jsonb), private.email_unsubscribe(text, boolean)
  from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.agent_action_propose(uuid, uuid, text, text, text, text, jsonb), private.email_unsubscribe(text, boolean) to hub_app_server;

-- ---------------------------------------------------------------------------------------
-- 7. The agent. The daily run (08:20 Eastern) proposes what is due; its proposals wait on the Team screen without holding back the
--    next day's run. auto_send_templates starts empty, so nothing is sent on its own until the owner lists a template, and it is
--    added only where it is missing, so a value the owner set is never overwritten. The role summary is updated only while it is
--    still the seeded text.
-- ---------------------------------------------------------------------------------------
insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('account_manager', 'accounts.lifecycle', 'daily', null, '08:20', 'America/New_York', false,
  private.agent_schedule_next('daily', null, '08:20', 'America/New_York', now(), null))
on conflict (agent_key, task_kind) do nothing;

update private.agents set config = config || '{"auto_send_templates": []}'::jsonb
where key = 'account_manager' and not (config ? 'auto_send_templates');

update private.agents
set role_summary = 'Reads the Hub''s own billing mirror, the applications'' usage reports and the support cases, scores how each account is doing, emails you every Monday who needs attention, and proposes short welcome, setup and check-in emails to customers for you to approve.'
where key = 'account_manager'
  and role_summary = 'Reads the Hub''s own billing mirror, the applications'' usage reports and the support cases, scores how each account is doing, and emails you every Monday who needs attention. Sends nothing to customers.';
