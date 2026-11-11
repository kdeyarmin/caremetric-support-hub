-- Native activity uses the already scoped application key and canonical billing account binding.
-- No email/name matching, no new secrets, no historical conversion backfill.
create function private.growth_ensure_customer(p_tenant uuid,p_product text) returns uuid
language plpgsql security definer set search_path='' as $$
declare org uuid; begin
 if p_product not in ('carebase','caremetric-intel') or not exists(select 1 from hub.tenants where id=p_tenant) then
  raise exception 'Unknown growth customer' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 select id into org from private.growth_organizations where tenant_id=p_tenant;
 if org is null then
  insert into private.growth_organizations(name,domain,tenant_id)
  select name,'customer-'||p_tenant::text||'.invalid',id from hub.tenants where id=p_tenant
  returning id into org;
 end if;
 -- A linked customer whose first signal is a heartbeat must never enter the cold-prospect pipeline.
 insert into private.growth_opportunities as o(organization_id,product,stage,owner_agent,next_action)
 values(org,p_product,'nurture','account_manager','Wait for verified product activity')
 on conflict(organization_id,product) do update set owner_agent='account_manager',
  stage=case when o.stage in ('identified','researched','qualified','contacted','engaged','demo') then 'nurture' else o.stage end,
  version=o.version+1,updated_at=now()
 where o.owner_agent='marketing_manager';
 -- A first heartbeat can establish customer context before a trial signal; stale cold drafts must not survive that handoff.
 update private.growth_messages m set status='cancelled' from private.growth_opportunities o
 where m.opportunity_id=o.id and o.organization_id=org and o.product=p_product and m.status in ('draft','proposed') and m.opportunity_version<>o.version;
 return org;
end; $$;
revoke all on function private.growth_ensure_customer(uuid,text) from public,anon,authenticated,service_role,hub_app_server;

create function private.growth_app_event(p_key_hash text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare app jsonb; tenant uuid; payload jsonb; begin
 perform private.require_hub_app_server();
 app:=private.billing_authenticate_app(p_key_hash);
 if app is null then raise exception 'Application key required' using errcode='28000';end if;
 if app->>'slug'<>'caremetric-intel' then raise exception 'Unsupported activity application' using errcode='42501';end if;
 if jsonb_typeof(p_data)<>'object' or (p_data->>'account') !~ '^[0-9a-f]{24}$'
  or (p_data->>'eventKey') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  or coalesce(p_data->>'kind','') not in ('heartbeat','active','first_value')
  or exists(select 1 from jsonb_object_keys(p_data) k where k not in ('account','eventKey','kind','occurredAt','facts'))
  or jsonb_typeof(p_data->'facts')<>'object'
  or exists(select 1 from jsonb_object_keys(p_data->'facts') k where k not in ('count','metric'))
  or (p_data->'facts' ? 'metric' and p_data->'facts'->>'metric'<>'provider_lists')
  or (p_data->'facts' ? 'count' and (p_data->'facts'->>'count' !~ '^\d{1,7}$' or (p_data->'facts'->>'count')::integer>1000000))
  or (p_data->>'kind'='first_value' and (coalesce(p_data->'facts'->>'metric','')<>'provider_lists' or coalesce((p_data->'facts'->>'count')::integer,0)<1)) then
  raise exception 'Invalid application activity' using errcode='22023';
 end if;
 tenant:=private.billing_resolve_account((app->>'product_id')::uuid,p_data->>'account');
 if tenant is null then raise exception 'Account not linked' using errcode='P0002';end if;
 perform private.growth_ensure_customer(tenant,app->>'slug');
 payload:=(p_data-'account')||jsonb_build_object('tenantId',tenant,'eventKey','native:'||(p_data->>'account')||':'||(p_data->>'eventKey'));
 return private.growth_record_event(app->>'slug',payload);
end; $$;
revoke all on function private.growth_app_event(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.growth_app_event(text,jsonb) to hub_app_server;

-- Durable prospective billing observations. Capture does no customer work and never makes network calls.
create table private.growth_billing_outbox (
 event_key text primary key,
 tenant_id uuid not null references hub.tenants(id),
 product text not null check(product in ('carebase','caremetric-intel')),
 kind text not null check(kind in ('trial_started','paid')),
 subscription_id text not null,
 occurred_at timestamptz not null,
 facts jsonb not null default '{}',
 created_at timestamptz not null default now(),
 processed_at timestamptz,
 expired_at timestamptz,
 next_attempt_at timestamptz not null default now(),
 attempts integer not null default 0,
 last_error text
);
alter table private.growth_billing_outbox enable row level security;
revoke all on private.growth_billing_outbox from public,anon,authenticated,service_role,hub_app_server;
create index growth_billing_outbox_pending on private.growth_billing_outbox(created_at) where processed_at is null;
create table private.growth_lifecycle_start (id boolean primary key default true check(id),started_at timestamptz not null default now());
insert into private.growth_lifecycle_start default values;
alter table private.growth_lifecycle_start enable row level security;
revoke all on private.growth_lifecycle_start from public,anon,authenticated,service_role,hub_app_server;

create function private.growth_queue_paid(invoice private.billing_invoices,p_was_paid boolean default true) returns void
language plpgsql security definer set search_path='' as $$
declare product text; subscription private.billing_subscriptions; began timestamptz; begin
 if not invoice.livemode or invoice.status<>'paid' or invoice.amount_paid<=0 or invoice.stripe_subscription_id is null then return;end if;
 select * into subscription from private.billing_subscriptions where stripe_subscription_id=invoice.stripe_subscription_id and tenant_id=invoice.tenant_id and livemode;
 if not found then return;end if;
 select slug into product from hub.products where id=coalesce(invoice.product_id,subscription.product_id);
 if product is null or product not in ('carebase','caremetric-intel') or subscription.product_id is distinct from coalesce(invoice.product_id,subscription.product_id) then return;end if;
 select started_at into began from private.growth_lifecycle_start;
 -- An inserted historical paid invoice is not a new conversion. A previously open invoice can genuinely become paid now.
 if invoice.stripe_created<began and p_was_paid then return;end if;
 -- Existing buyers and renewals never become new conversions just because measurement was enabled.
 if exists(select 1 from private.billing_invoices i left join private.billing_subscriptions s on s.stripe_subscription_id=i.stripe_subscription_id
  where i.tenant_id=invoice.tenant_id and coalesce(i.product_id,s.product_id)=subscription.product_id
   and (i.stripe_created,i.stripe_invoice_id)<(invoice.stripe_created,invoice.stripe_invoice_id) and i.status='paid' and i.amount_paid>0 and i.livemode) then return;end if;
 -- Unknown pre-rollout history stays uncounted. A trial ending after rollout can still convert.
 if not (subscription.stripe_created>=began or coalesce(subscription.trial_end>=began,false)) then return;end if;
 insert into private.growth_billing_outbox(event_key,tenant_id,product,kind,subscription_id,occurred_at)
 values('billing:paid:'||subscription.stripe_subscription_id,invoice.tenant_id,product,'paid',subscription.stripe_subscription_id,invoice.seen_at) on conflict do nothing;
end;$$;
revoke all on function private.growth_queue_paid(private.billing_invoices,boolean) from public,anon,authenticated,service_role,hub_app_server;

create function private.growth_capture_billing() returns trigger
language plpgsql security definer set search_path='' as $$
declare product text; invoice private.billing_invoices;begin
 if not new.livemode then return new;end if;
 if tg_table_name='billing_invoices' then
  perform private.growth_queue_paid(new,case when tg_op='INSERT' then true else old.status='paid' and old.amount_paid>0 end);
  return new;
 end if;
 select slug into product from hub.products where id=new.product_id;
 if product is null or product not in ('carebase','caremetric-intel') then return new;end if;
 -- Webhooks can deliver a paid invoice before its subscription or product binding. Revisit recent, already paid invoices
 -- when the authoritative subscription arrives, without changing the mirrored invoice or inventing a payment timestamp.
 for invoice in select * from private.billing_invoices where stripe_subscription_id=new.stripe_subscription_id
  and status='paid' and amount_paid>0 and stripe_created>=(select started_at from private.growth_lifecycle_start)
  order by stripe_created limit 10 loop
  perform private.growth_queue_paid(invoice,true);
 end loop;
 if new.status='trialing' and new.trial_start is not null and new.trial_start>=(select started_at from private.growth_lifecycle_start) then
  insert into private.growth_billing_outbox(event_key,tenant_id,product,kind,subscription_id,occurred_at,facts)
  values('billing:trial:'||new.stripe_subscription_id,new.tenant_id,product,'trial_started',new.stripe_subscription_id,new.trial_start,
    jsonb_strip_nulls(jsonb_build_object('trialEnd',new.trial_end))) on conflict do nothing;
 end if;
 return new;
end;$$;
revoke all on function private.growth_capture_billing() from public,anon,authenticated,service_role,hub_app_server;
create trigger growth_billing_subscription after insert or update on private.billing_subscriptions for each row execute function private.growth_capture_billing();
create trigger growth_billing_invoice after insert or update on private.billing_invoices for each row execute function private.growth_capture_billing();

create function private.growth_drain_billing() returns integer
language plpgsql security definer set search_path='' as $$
declare event private.growth_billing_outbox; applied integer:=0; begin
 perform private.require_hub_app_server();
 update private.growth_billing_outbox set expired_at=now(),last_error='expired' where processed_at is null and expired_at is null and occurred_at<now()-interval '89 days';
 -- Filter held checkouts before LIMIT, so an unverified queue cannot starve later valid events.
 for event in select b.* from private.growth_billing_outbox b where b.processed_at is null and b.expired_at is null and b.next_attempt_at<=now()
  and not exists(select 1 from private.customer_checkout_holds h where h.stripe_subscription_id=b.subscription_id
   and not exists(select 1 from private.customer_billing_quotes q where q.id=h.quote_id and q.state='applied'
    and q.stripe_subscription_id=b.subscription_id and q.tenant_id=b.tenant_id and q.checkout_verified_at is not null))
  order by b.created_at limit 100 for update of b skip locked loop
  begin
   perform private.growth_ensure_customer(event.tenant_id,event.product);
   perform private.growth_record_event(event.product,jsonb_build_object('tenantId',event.tenant_id,'eventKey',event.event_key,
    'kind',event.kind,'occurredAt',event.occurred_at,'facts',event.facts));
   update private.growth_billing_outbox set processed_at=now(),attempts=attempts+1,last_error=null where event_key=event.event_key;
   applied:=applied+1;
  exception when others then
   update private.growth_billing_outbox set attempts=attempts+1,last_error=sqlstate,
    next_attempt_at=now()+make_interval(secs=>least(3600,30*power(2,least(attempts,7)))::integer) where event_key=event.event_key;
  end;
 end loop;
 return applied;
end;$$;
revoke all on function private.growth_drain_billing() from public,anon,authenticated,service_role;
grant execute on function private.growth_drain_billing() to hub_app_server;

-- Use the existing fifteen-minute growth worker, with its existing scheduler switch and task retry semantics.
alter function private.growth_maintenance() rename to growth_maintenance_before_lifecycle;
revoke all on function private.growth_maintenance_before_lifecycle() from public,anon,authenticated,service_role,hub_app_server;
create function private.growth_maintenance() returns integer
language plpgsql security definer set search_path='' as $$ begin
 perform private.require_hub_app_server();
 return private.growth_drain_billing()+private.growth_maintenance_before_lifecycle();
end;$$;
revoke all on function private.growth_maintenance() from public,anon,authenticated,service_role;
grant execute on function private.growth_maintenance() to hub_app_server;

-- Verified lifecycle counts are separate from form submissions and inferred active subscriptions.
alter function private.agent_scorecard_facts_json(timestamptz,timestamptz) rename to agent_scorecard_facts_before_lifecycle;
revoke all on function private.agent_scorecard_facts_before_lifecycle(timestamptz,timestamptz) from public,anon,authenticated,service_role,hub_app_server;
create function private.agent_scorecard_facts_json(p_since timestamptz,p_until timestamptz) returns jsonb
language sql stable set search_path='' as $$
 with base as (select private.agent_scorecard_facts_before_lifecycle(p_since,p_until)||jsonb_build_object('lifecycleStartedAt',(select started_at from private.growth_lifecycle_start)) as value),
 verified as (
  select e.organization_id,e.product,e.kind,min(e.occurred_at) as first_at
  from private.customer_activity_events e join private.growth_organizations g on g.id=e.organization_id
  join private.growth_billing_outbox b on b.event_key=e.event_key and b.product=e.product and b.kind=e.kind and b.processed_at is not null
  where not g.internal group by e.organization_id,e.product,e.kind
 )
 select jsonb_set(value,'{products}',(select jsonb_agg(p||jsonb_build_object(
  'verifiedPaid',(select count(*) from verified v where v.product=p->>'product' and v.kind='paid' and v.first_at>=p_since and v.first_at<p_until),
  'verifiedTrialStarts',(select count(*) from verified v where v.product=p->>'product' and v.kind='trial_started' and v.first_at>=p_since and v.first_at<p_until)) order by p->>'product')
  from jsonb_array_elements(value->'products') p)) from base;
$$;
revoke all on function private.agent_scorecard_facts_json(timestamptz,timestamptz) from public,anon,authenticated,service_role,hub_app_server;
