-- CareBase and Intel growth domain. No migration enables sending or changes existing agent autonomy.
create table private.growth_organizations (
 id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 200),
 domain text not null unique check(domain ~ '^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$'),
 tenant_id uuid unique references hub.tenants(id), internal boolean not null default false, created_at timestamptz not null default now()
);
create table private.growth_contacts (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references private.growth_organizations(id),
 email text not null unique check(email=lower(btrim(email)) and email ~ '^[^ @]+@[^ @]+\.[^ @]+$'),
 name text not null default '' check(length(name)<=200), role text not null default '' check(length(role)<=200),
 eligibility text not null default 'review' check(eligibility in ('review','permitted','opted_out')),
 verified_at timestamptz, source_url text check(length(source_url)<=2000), version integer not null default 1,
 created_at timestamptz not null default now(), unique(id,organization_id)
);
create table private.growth_opportunities (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references private.growth_organizations(id),
 product text not null check(product in ('carebase','caremetric-intel')), contact_id uuid,
 stage text not null default 'identified' check(stage in ('identified','researched','qualified','contacted','engaged','demo','trial','activated','paying','retained','nurture','lost','churned','disqualified')),
 owner_agent text not null default 'marketing_manager' references private.agents(key),
 goal text not null default '' check(length(goal)<=2000), memory jsonb not null default '{}' check(jsonb_typeof(memory)='object' and pg_column_size(memory)<=12000),
 fit integer check(fit between 0 and 100), intent integer check(intent between 0 and 100),
 next_action text not null default 'Research organization' check(length(next_action) between 1 and 500), next_at timestamptz not null default now(),
 trial_end timestamptz, renewal_at timestamptz, activated_at timestamptz, paid_at timestamptz, churned_at timestamptz,
 version integer not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(organization_id,product), foreign key(contact_id,organization_id) references private.growth_contacts(id,organization_id)
);
create table private.growth_evidence (
 id uuid primary key default gen_random_uuid(), opportunity_id uuid not null references private.growth_opportunities(id),
 source_url text not null check(source_url ~ '^https://' and length(source_url)<=2000),
 claim text not null check(length(claim) between 1 and 4000), confidence text not null check(confidence in ('low','medium','high')),
 observed_at timestamptz not null, created_at timestamptz not null default now(), unique(opportunity_id,source_url,claim)
);
create table private.customer_activity_events (
 id uuid primary key default gen_random_uuid(), product text not null check(product in ('carebase','caremetric-intel')),
 organization_id uuid not null references private.growth_organizations(id), event_key text not null check(length(event_key) between 1 and 200),
 kind text not null check(kind in ('signup','heartbeat','active','first_value','trial_started','paid','renewed','cancel_requested','churned','support_blocked','support_resolved','expansion_interest','meeting_booked','positive_reply','reply','negative_reply','not_now')),
 occurred_at timestamptz not null, received_at timestamptz not null default now(),
 facts jsonb not null default '{}' check(jsonb_typeof(facts)='object' and pg_column_size(facts)<=2000), unique(product,event_key)
);
create index customer_activity_by_org on private.customer_activity_events(organization_id,product,occurred_at desc);
create table private.customer_success_plans (
 id uuid primary key default gen_random_uuid(), opportunity_id uuid not null references private.growth_opportunities(id),
 trigger_key text not null check(length(trigger_key)<=200), kind text not null check(length(kind)<=60),
 action text not null check(length(action) between 1 and 1000), success_criterion text not null check(length(success_criterion) between 1 and 1000),
 owner_agent text not null references private.agents(key), due_at timestamptz not null,
 status text not null default 'open' check(status in ('open','resolved','cancelled')), outcome text check(length(outcome)<=2000),
 resolved_at timestamptz, created_at timestamptz not null default now(), unique(opportunity_id,trigger_key)
);
create table private.growth_policies (
 product text primary key check(product in ('carebase','caremetric-intel')), enabled boolean not null default false,
 auto_send boolean not null default false, experiment_enabled boolean not null default false, daily_limit integer not null default 10 check(daily_limit between 1 and 100),
 min_gap_hours integer not null default 72 check(min_gap_hours between 24 and 720), max_touches integer not null default 3 check(max_touches between 1 and 3),
 booking_url text not null default '' check(booking_url='' or booking_url ~ '^https://'),
 approved_claim text not null default '' check(length(approved_claim)<=1000), version integer not null default 1,
 updated_at timestamptz not null default now()
);
insert into private.growth_policies(product) values ('carebase'),('caremetric-intel');
create table private.growth_messages (
 id uuid primary key default gen_random_uuid(), opportunity_id uuid not null references private.growth_opportunities(id),
 work_id uuid references private.customer_success_plans(id), contact_id uuid not null references private.growth_contacts(id),
 purpose text not null check(purpose in ('marketing','success')), subject text not null check(length(subject) between 1 and 150),
 body text not null check(length(body) between 1 and 4000), citations jsonb not null default '[]' check(jsonb_typeof(citations)='array'),
 opportunity_version integer not null, contact_version integer not null, policy_version integer not null,
 status text not null default 'draft' check(status in ('draft','proposed','sending','accepted','delivered','failed','unknown','cancelled','bounced','complaint')),
 action_id uuid unique references private.agent_actions(id), provider_id text, unsubscribe_hash text not null,
 model_generated boolean not null default false,
 variant text not null default 'control' check(variant in ('control','concise')),
 created_at timestamptz not null default now(), attempted_at timestamptz, delivered_at timestamptz,
 unique(work_id,opportunity_version,contact_version,policy_version)
);
create index growth_messages_unsubscribe on private.growth_messages(unsubscribe_hash);
create index growth_messages_contact on private.growth_messages(contact_id,attempted_at desc);
create table private.growth_delivery_events (
 event_id text primary key check(length(event_id)<=200), message_id uuid not null references private.growth_messages(id),
 kind text not null check(kind in ('delivered','bounced','complaint','unsubscribe')), occurred_at timestamptz not null, created_at timestamptz not null default now()
);
create table private.agent_evaluations (
 id uuid primary key default gen_random_uuid(), product text not null check(product in ('carebase','caremetric-intel')),
 version text not null check(length(version)<=60), passed boolean not null, results jsonb not null check(pg_column_size(results)<=12000), created_at timestamptz not null default now()
);

insert into private.agents(key,display_name,role_summary,status,autonomy,model_tier,daily_budget_cents,tool_allowlist,config)
values('marketing_manager','Marketing Manager','Researches qualified CareBase and Intel prospects, drafts evidence-backed outreach and tracks every next step. Sending starts disabled.','paused','propose','draft',300,array['growth_research','growth_plan','growth_draft'],'{"auto_approve_kinds":[],"effort":"medium"}') on conflict do nothing;
insert into private.agent_schedules(agent_key,task_kind,cadence,every_seconds,requires_session,next_run_at)
values('marketing_manager','growth.pipeline','interval',900,false,now()),('account_manager','growth.success','interval',900,false,now()) on conflict do nothing;
-- Record-only work uses its own domain. Only reviewed message actions can leave the Hub.
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
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_kinds || array['growth.message', 'growth.content']) as k) x));
  execute format('alter table private.agent_actions drop constraint agent_actions_target_kind_check, add constraint agent_actions_target_kind_check check (target_kind in (%s))',
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_targets || array['growth_message', 'growth_content']) as k) x));
end $$;
alter table private.agent_actions add column not_before timestamptz;

-- Owner reads are authorized independently of HTTP routing. Lists are paged; metrics cover the whole population.
create function private.growth_overview(p_offset integer default 0) returns jsonb
language plpgsql stable set search_path='' as $$
begin
 if p_offset is null or p_offset<0 then raise exception 'Invalid page' using errcode='22023'; end if;
 return jsonb_build_object('content',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select id,status,preview,input->>'campaign' as campaign from private.agent_actions where kind='growth.content' order by created_at desc limit 20) x),'policies',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from private.growth_policies p),
 'total',(select count(*) from private.growth_opportunities),
 'items',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select o.*,g.name,g.domain,g.internal,g.tenant_id,c.email,c.name as contact_name,c.eligibility,c.verified_at,c.version as contact_version
 from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id left join private.growth_contacts c on c.id=o.contact_id order by o.next_at,o.id limit 50 offset p_offset) x),
 'work',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select w.*,g.name,o.product from private.customer_success_plans w join private.growth_opportunities o on o.id=w.opportunity_id join private.growth_organizations g on g.id=o.organization_id where w.status='open' order by w.due_at,w.id limit 100) x),
 'metrics',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select product,stage,coalesce(memory->>'acquisitionSource','unknown') as source,date_trunc('month',created_at) as cohort,count(*) as accounts,
 count(*) filter(where exists(select 1 from private.customer_activity_events e where e.organization_id=o.organization_id and e.product=o.product and e.kind='trial_started')) as trials,
 count(*) filter(where exists(select 1 from private.customer_activity_events e where e.organization_id=o.organization_id and e.product=o.product and e.kind='positive_reply')) as positive_replies,
 count(*) filter(where exists(select 1 from private.customer_activity_events e where e.organization_id=o.organization_id and e.product=o.product and e.kind='meeting_booked')) as meetings,
 count(*) filter(where activated_at is not null) as activated,count(*) filter(where paid_at is not null) as paid,count(*) filter(where churned_at is not null) as churned,
 count(*) filter(where next_at<now() and stage not in ('lost','churned','disqualified')) as overdue,
 avg(extract(epoch from (activated_at-(select min(e.occurred_at) from private.customer_activity_events e where e.organization_id=o.organization_id and e.product=o.product and e.kind in ('signup','trial_started'))))/3600) as hours_to_value,
 count(*) filter(where paid_at<=now()-interval '30 days') as eligible_30d,
 count(*) filter(where paid_at<=now()-interval '30 days' and (churned_at is null or churned_at>paid_at+interval '30 days')) as retained_30d,
 count(*) filter(where paid_at<=now()-interval '60 days') as eligible_60d,
 count(*) filter(where paid_at<=now()-interval '60 days' and (churned_at is null or churned_at>paid_at+interval '60 days')) as retained_60d,
 count(*) filter(where paid_at<=now()-interval '90 days') as eligible_90d,
 count(*) filter(where paid_at<=now()-interval '90 days' and (churned_at is null or churned_at>paid_at+interval '90 days')) as retained_90d
 from private.growth_opportunities o where not exists(select 1 from private.growth_organizations g where g.id=o.organization_id and g.internal) group by product,stage,coalesce(memory->>'acquisitionSource','unknown'),date_trunc('month',created_at)) x),
 'deliveries',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select o.product,m.variant,m.status,count(*) as count from private.growth_messages m join private.growth_opportunities o on o.id=m.opportunity_id group by o.product,m.variant,m.status) x));
end; $$;
create function hub.growth_workspace(p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$ begin perform hub.authorize_app_admin(); return private.growth_overview(p_offset); end; $$;

-- A version check prevents a stale screen from overwriting the next action, policy or consent.
create function hub.growth_manage(p_operation text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor uuid; v_org uuid; v_contact uuid; v_id uuid; v_version integer; v_opp private.growth_opportunities%rowtype;
begin
 v_actor:=(hub.authorize_app_command()->>'user_id')::uuid;
 perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 if p_data is null or jsonb_typeof(p_data)<>'object' or pg_column_size(p_data)>24000 then raise exception 'Invalid record' using errcode='22023'; end if;
 if p_operation='create' then
  insert into private.growth_organizations(name,domain,tenant_id,internal) values(p_data->>'name',lower(p_data->>'domain'),nullif(p_data->>'tenantId','')::uuid,coalesce((p_data->>'internal')::boolean,false))
  on conflict(domain) do update set domain=excluded.domain returning id into v_org;
  if nullif(p_data->>'email','') is not null then
   insert into private.growth_contacts(organization_id,email,name,role) values(v_org,lower(btrim(p_data->>'email')),coalesce(p_data->>'contactName',''),coalesce(p_data->>'role',''))
   on conflict(email) do nothing returning id into v_contact;
   if v_contact is null then select id into v_contact from private.growth_contacts where email=lower(btrim(p_data->>'email')) and organization_id=v_org; end if;
   if v_contact is null then raise exception 'Contact already belongs to another organization' using errcode='22023'; end if;
  end if;
  insert into private.growth_opportunities(organization_id,product,contact_id,goal) values(v_org,p_data->>'product',v_contact,coalesce(p_data->>'goal',''))
  on conflict(organization_id,product) do update set contact_id=coalesce(private.growth_opportunities.contact_id,excluded.contact_id) returning id into v_id;
  if v_id is null then select id into v_id from private.growth_opportunities where organization_id=v_org and product=p_data->>'product'; end if;
 elsif p_operation='opportunity' then
  select * into v_opp from private.growth_opportunities where id=(p_data->>'id')::uuid for update;
  if not found or v_opp.version<>(p_data->>'version')::integer then raise exception 'Refresh this opportunity' using errcode='40001'; end if;
  update private.growth_organizations set internal=coalesce((p_data->>'internal')::boolean,internal),tenant_id=case when p_data?'tenantId' then nullif(p_data->>'tenantId','')::uuid else tenant_id end where id=v_opp.organization_id;
  update private.growth_opportunities set stage=p_data->>'stage',goal=p_data->>'goal',memory=memory||coalesce(p_data->'memory','{}'),next_action=p_data->>'nextAction',next_at=(p_data->>'nextAt')::timestamptz,
  owner_agent=case when p_data->>'stage' in ('trial','activated','paying','retained','churned') then 'account_manager' else 'marketing_manager' end,
  trial_end=nullif(p_data->>'trialEnd','')::timestamptz,renewal_at=nullif(p_data->>'renewalAt','')::timestamptz,
  activated_at=case when p_data->>'stage'='activated' then coalesce(activated_at,now()) else activated_at end,
  paid_at=case when p_data->>'stage'='paying' then coalesce(paid_at,now()) else paid_at end,
  churned_at=case when p_data->>'stage'='churned' then coalesce(churned_at,now()) else churned_at end,
  version=version+1,updated_at=now() where id=v_opp.id returning id into v_id;
  update private.growth_messages set status='cancelled' where opportunity_id=v_id and status in ('draft','proposed');
 elsif p_operation='contact' then
  if p_data->>'eligibility'='permitted' and (nullif(p_data->>'sourceUrl','') is null or (p_data->>'verified')::boolean is not true) then raise exception 'Verify the contact and outreach eligibility first' using errcode='22023'; end if;
  update private.growth_contacts set eligibility=p_data->>'eligibility',verified_at=case when (p_data->>'verified')::boolean then now() else null end,source_url=p_data->>'sourceUrl',version=version+1
  where id=(p_data->>'id')::uuid and version=(p_data->>'version')::integer returning id into v_id;
  if v_id is null then raise exception 'Refresh this contact' using errcode='40001'; end if;
  if p_data->>'eligibility'='opted_out' then insert into private.email_suppressions(email_hash) select encode(extensions.digest(email,'sha256'),'hex') from private.growth_contacts where id=v_id on conflict do nothing; end if;
 elsif p_operation='evidence' then
  insert into private.growth_evidence(opportunity_id,source_url,claim,confidence,observed_at) values((p_data->>'opportunityId')::uuid,p_data->>'sourceUrl',p_data->>'claim',p_data->>'confidence',(p_data->>'observedAt')::timestamptz) on conflict(opportunity_id,source_url,claim) do update set confidence=excluded.confidence,observed_at=excluded.observed_at returning id into v_id;
 elsif p_operation='policy' then
  if (p_data->>'enabled')::boolean and nullif(btrim(p_data->>'approvedClaim'),'') is null then raise exception 'Review a product claim before enabling sending' using errcode='22023'; end if;
  update private.growth_policies set enabled=(p_data->>'enabled')::boolean,auto_send=(p_data->>'autoSend')::boolean,experiment_enabled=coalesce((p_data->>'experimentEnabled')::boolean,false),daily_limit=(p_data->>'dailyLimit')::integer,
  min_gap_hours=(p_data->>'minGapHours')::integer,max_touches=(p_data->>'maxTouches')::integer,booking_url=p_data->>'bookingUrl',approved_claim=p_data->>'approvedClaim',version=version+1,updated_at=now()
  where product=p_data->>'product' and version=(p_data->>'version')::integer returning version into v_version;
  if v_version is null then raise exception 'Refresh this policy' using errcode='40001'; end if;
  if (p_data->>'autoSend')::boolean then update private.agents set config=jsonb_set(config,'{auto_approve_kinds}', '["growth.message"]'),updated_at=now() where key in ('marketing_manager','account_manager'); end if;
 elsif p_operation='reconcile' then
  if p_data->>'status' not in ('delivered','failed') or length(btrim(p_data->>'reference'))<3 then raise exception 'Record the provider outcome and its reference' using errcode='22023'; end if;
  update private.growth_messages set status=p_data->>'status',delivered_at=case when p_data->>'status'='delivered' then now() else delivered_at end
  where id=(p_data->>'id')::uuid and status='unknown' returning id into v_id;
  if v_id is null then raise exception 'Refresh the message outcome' using errcode='40001'; end if;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata) values(v_actor,'growth.delivery_reconciled','growth_message',v_id,jsonb_build_object('outcome',p_data->>'status','providerReference',left(p_data->>'reference',500)));
 elsif p_operation='resolve' then
  update private.customer_success_plans set status='resolved',outcome=p_data->>'outcome',resolved_at=now() where id=(p_data->>'id')::uuid and status='open' returning id into v_id;
 else raise exception 'Unsupported growth operation' using errcode='22023'; end if;
 insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata) values(v_actor,'growth.'||p_operation,'growth',v_id,jsonb_build_object('version',v_version));
 return jsonb_build_object('id',v_id,'version',v_version);
end; $$;

create function private.growth_snapshot(p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$ begin
 perform private.require_hub_app_server();
 if p_offset is null or p_offset<0 then raise exception 'Invalid offset' using errcode='22023'; end if;
 return jsonb_build_object('total',(select count(*) from private.growth_opportunities),'items',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (
 select o.*,g.name,g.domain,g.internal,g.tenant_id,c.name as contact_name,c.eligibility,c.verified_at,c.version as contact_version,
 (select to_jsonb(p) from private.growth_policies p where p.product=o.product) as policy,
 (select coalesce(jsonb_agg(to_jsonb(e)),'[]') from (select id,source_url,claim,confidence,observed_at from private.growth_evidence where opportunity_id=o.id order by observed_at desc limit 20) e) as evidence,
 (select coalesce(jsonb_agg(to_jsonb(e)),'[]') from (select kind,occurred_at,facts from private.customer_activity_events where organization_id=o.organization_id and product=o.product and occurred_at>now()-interval '90 days' order by occurred_at desc limit 500) e) as events,
 (select coalesce(jsonb_agg(to_jsonb(w)),'[]') from (select w.*,m.id as message_id,m.status as message_status from private.customer_success_plans w left join lateral(select m1.* from private.growth_messages m1 where m1.work_id=w.id order by m1.created_at desc limit 1) m on true where w.opportunity_id=o.id) w) as work,
 (select count(*) from private.growth_messages m where m.opportunity_id=o.id and m.purpose='marketing' and m.attempted_at is not null) as touches,
 (select max(m.attempted_at) from private.growth_messages m where m.contact_id=o.contact_id) as last_touch
 from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id left join private.growth_contacts c on c.id=o.contact_id order by o.id limit 100 offset p_offset) x));
end; $$;

create function private.growth_record_event(p_product text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_org uuid; v_id uuid; v_existing private.customer_activity_events%rowtype; v_kind text:=p_data->>'kind'; v_at timestamptz:=(p_data->>'occurredAt')::timestamptz;
begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 if p_product not in ('carebase','caremetric-intel') or v_at is null or v_at>now()+interval '5 minutes' or v_at<now()-interval '90 days' then raise exception 'Invalid event' using errcode='22023'; end if;
 select id into v_org from private.growth_organizations where tenant_id=(p_data->>'tenantId')::uuid;
 if v_org is null then raise exception 'Map this tenant to an organization first' using errcode='22023'; end if;
 insert into private.customer_activity_events(product,organization_id,event_key,kind,occurred_at,facts) values(p_product,v_org,p_data->>'eventKey',v_kind,v_at,coalesce(p_data->'facts','{}'))
 on conflict(product,event_key) do nothing returning id into v_id;
 if v_id is null then
  select * into v_existing from private.customer_activity_events where product=p_product and event_key=p_data->>'eventKey';
  if v_existing.organization_id<>v_org or v_existing.kind<>v_kind or v_existing.occurred_at<>v_at or v_existing.facts<>coalesce(p_data->'facts','{}') then raise exception 'Event key already used' using errcode='22023'; end if;
  return jsonb_build_object('replay',true);
 end if;
 -- A feed observation or meeting does not establish a trial. Lifecycle events below set the stage and owner.
 insert into private.growth_opportunities(organization_id,product,next_action) values(v_org,p_product,'Review product activity and qualify the opportunity') on conflict do nothing;
 -- Historical milestones must survive out-of-order delivery even when a newer event owns the current stage.
 update private.growth_opportunities set
 activated_at=case when v_kind='first_value' then least(activated_at,v_at) else activated_at end,
 paid_at=case when v_kind='paid' then least(paid_at,v_at) else paid_at end,
 churned_at=case when v_kind='churned' then least(churned_at,v_at) else churned_at end,
 version=version+1,updated_at=now()
 where organization_id=v_org and product=p_product
 and ((v_kind='first_value' and (activated_at is null or v_at<activated_at))
   or (v_kind='paid' and (paid_at is null or v_at<paid_at))
   or (v_kind='churned' and (churned_at is null or v_at<churned_at)));
 -- Older events remain evidence but cannot regress a more recent lifecycle decision.
 update private.growth_opportunities set stage=case v_kind when 'signup' then case when stage in ('identified','researched','qualified','contacted','engaged','demo') then 'trial' else stage end when 'first_value' then case when stage in ('paying','retained','churned') then stage else 'activated' end when 'paid' then 'paying' when 'renewed' then 'retained' when 'churned' then 'churned' when 'trial_started' then case when stage in ('paying','retained','activated') then stage else 'trial' end when 'meeting_booked' then case when stage in ('identified','researched','qualified','contacted','engaged') then 'demo' else stage end when 'positive_reply' then case when stage in ('identified','researched','qualified','contacted') then 'engaged' else stage end else stage end,
 memory=case when v_kind in ('signup','trial_started') and not(memory?'acquisitionSource') then memory||jsonb_strip_nulls(jsonb_build_object('acquisitionSource',p_data->'facts'->>'source','acquisitionCampaign',p_data->'facts'->>'campaign')) else memory end,
 owner_agent=case when v_kind in ('signup','trial_started','first_value','paid','renewed','churned','cancel_requested') then 'account_manager' else owner_agent end,
 trial_end=case when v_kind='trial_started' then coalesce(nullif(p_data->'facts'->>'trialEnd','')::timestamptz,trial_end) else trial_end end,
 next_action=case when v_kind in ('reply','positive_reply','negative_reply','not_now') then 'Review customer reply and agree the next step' when v_kind='cancel_requested' then 'Resolve cancellation concerns' when v_kind in ('signup','trial_started') then 'Establish the customer goal' else next_action end,
 next_at=least(next_at,now()), version=version+1,updated_at=now()
 where organization_id=v_org and product=p_product and v_kind not in ('heartbeat','active')
 and not exists(select 1 from private.customer_activity_events e where e.organization_id=v_org and e.product=p_product and e.kind in ('signup','trial_started','first_value','paid','renewed','churned') and v_kind in ('signup','trial_started','first_value','paid','renewed','churned') and e.occurred_at>v_at);
 if v_kind not in ('heartbeat','active') then
  -- A delayed event that leaves context unchanged must not strand its existing draft generation.
  update private.growth_messages m set status='cancelled' from private.growth_opportunities o
  where m.opportunity_id=o.id and o.organization_id=v_org and o.product=p_product
  and m.opportunity_version<>o.version and m.status in ('draft','proposed');
 end if;
 if v_kind in ('heartbeat','active','first_value','paid','renewed','support_resolved') then
  update private.customer_success_plans set status='resolved',outcome='Verified product event: '||v_kind,resolved_at=now() where opportunity_id in(select id from private.growth_opportunities where organization_id=v_org and product=p_product)
  and status='open' and ((v_kind in ('heartbeat','active') and v_at>now()-interval '2 days' and kind='telemetry') or (v_kind='active' and v_at>now()-interval '2 days' and kind='adoption' and (select count(distinct e.occurred_at::date) from private.customer_activity_events e where e.organization_id=v_org and e.product=p_product and e.kind in ('active','first_value') and e.occurred_at>=private.customer_success_plans.created_at)>=2) or (v_kind='first_value' and kind in ('onboarding','activation')) or (v_kind='paid' and kind='trial') or (v_kind='renewed' and kind='renewal') or (v_kind='support_resolved' and kind='support' and not exists(select 1 from private.customer_activity_events e where e.organization_id=v_org and e.product=p_product and e.kind='support_blocked' and e.occurred_at>v_at)));
 end if;
 return jsonb_build_object('id',v_id,'replay',false);
end; $$;

create function private.growth_plan(p_opportunity uuid,p_data jsonb) returns uuid
language plpgsql security definer set search_path='' as $$ declare v_id uuid; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 insert into private.customer_success_plans(opportunity_id,trigger_key,kind,action,success_criterion,owner_agent,due_at)
 values(p_opportunity,p_data->>'key',p_data->>'kind',p_data->>'action',p_data->>'success',p_data->>'owner',(p_data->>'dueAt')::timestamptz)
 on conflict(opportunity_id,trigger_key) do update set trigger_key=excluded.trigger_key returning id into v_id;
 return v_id;
end; $$;

create function private.growth_draft(p_opportunity uuid,p_work uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$ declare v_o private.growth_opportunities%rowtype; v_id uuid; v_contact_version integer; v_policy_version integer; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 select * into v_o from private.growth_opportunities where id=p_opportunity for update;
 if not found or v_o.contact_id is null or v_o.version is distinct from (p_data->>'version')::integer then raise exception 'Opportunity changed or lacks contact' using errcode='40001'; end if;
 select version into v_contact_version from private.growth_contacts where id=v_o.contact_id;
 select version into v_policy_version from private.growth_policies where product=v_o.product;
 if v_contact_version is distinct from (p_data->>'contactVersion')::integer or v_policy_version is distinct from (p_data->>'policyVersion')::integer then
  raise exception 'Draft context changed; regenerate from the current contact and policy' using errcode='40001';
 end if;
 if not exists(select 1 from private.customer_success_plans where id=p_work and opportunity_id=p_opportunity and status='open') then raise exception 'Work no longer open' using errcode='40001'; end if;
 insert into private.growth_messages(opportunity_id,work_id,contact_id,purpose,subject,body,citations,opportunity_version,contact_version,policy_version,unsubscribe_hash,variant,model_generated)
 select v_o.id,p_work,c.id,p_data->>'purpose',p_data->>'subject',p_data->>'body',p_data->'citations',v_o.version,c.version,p.version,p_data->>'unsubscribeHash',coalesce(p_data->>'variant','control'),coalesce((p_data->>'modelGenerated')::boolean,false)
 from private.growth_contacts c join private.growth_policies p on p.product=v_o.product where c.id=v_o.contact_id
 on conflict(work_id,opportunity_version,contact_version,policy_version) do nothing returning id into v_id;
 if v_id is null then select id into v_id from private.growth_messages where work_id=p_work and opportunity_version=v_o.version and contact_version=(select version from private.growth_contacts where id=v_o.contact_id) and policy_version=(select version from private.growth_policies where product=v_o.product); end if;
 return (select jsonb_build_object('id',id,'subject',subject,'body',body,'status',status,'actionId',action_id) from private.growth_messages where id=v_id);
end; $$;
-- All short growth mutations share a transaction lock; network calls are outside the lock.
-- Claim serializes across products on the contact and policy. Unknown deliveries are never automatically retried.
create function private.growth_claim_message(p_id uuid,p_action uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m private.growth_messages%rowtype; o private.growth_opportunities%rowtype; c private.growth_contacts%rowtype; p private.growth_policies%rowtype; a private.agent_actions%rowtype; g private.agents%rowtype; v_n integer;
begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 select * into m from private.growth_messages where id=p_id for update;
 if not found then raise exception 'Unknown message' using errcode='22023'; end if;
 if m.status not in ('draft','proposed') then return jsonb_build_object('send',false,'status',m.status); end if;
 select * into a from private.agent_actions where id=p_action;
 select * into g from private.agents where key=a.agent_key;
 select * into o from private.growth_opportunities where id=m.opportunity_id for update;
 select * into c from private.growth_contacts where id=m.contact_id for update;
 select * into p from private.growth_policies where product=o.product for update;
 if a.id is null or a.id<>m.action_id or a.status<>'executing' or a.kind<>'growth.message' or a.target_id<>m.id::text
 or g.status<>'active' or g.autonomy='observe' or (a.decided_by is null and not(p.auto_send and g.autonomy='act')) then raise exception 'Message not authorized' using errcode='42501'; end if;
 if not p.enabled or p.version<>m.policy_version or o.version<>m.opportunity_version or c.version<>m.contact_version
 or c.eligibility<>'permitted' or c.verified_at is null or c.verified_at<now()-interval '90 days'
 or exists(select 1 from private.growth_organizations where id=o.organization_id and internal)
 or exists(select 1 from private.email_suppressions where email_hash=encode(extensions.digest(c.email,'sha256'),'hex'))
 or (m.purpose='marketing' and not exists(select 1 from private.growth_evidence e where e.opportunity_id=o.id and e.id::text in(select jsonb_array_elements_text(m.citations)) and e.observed_at between now()-interval '30 days' and now()))
 or o.stage in ('lost','churned','disqualified','nurture')
 or (m.purpose='marketing' and (o.stage not in ('qualified','contacted') or exists(select 1 from private.customer_activity_events e where e.organization_id=o.organization_id and e.kind in ('reply','positive_reply','negative_reply','not_now','meeting_booked','trial_started'))))
 or not exists(select 1 from private.customer_success_plans where id=m.work_id and status='open') then
  update private.growth_messages set status='cancelled' where id=m.id; return jsonb_build_object('send',false,'status','cancelled');
 end if;
 if a.decided_by is null and coalesce((select e.passed from private.agent_evaluations e where e.product=o.product and e.version='growth.1' and e.created_at>now()-interval '30 days' order by e.created_at desc limit 1),false) is not true then return jsonb_build_object('send',false,'status','evaluation_required'); end if;
 if exists(select 1 from private.growth_messages where contact_id=c.id and id<>m.id and status in ('unknown','sending')) then return jsonb_build_object('send',false,'status','delivery_unresolved'); end if;
 if exists(select 1 from private.growth_messages where contact_id=c.id and attempted_at>now()-make_interval(hours=>(select max(min_gap_hours) from private.growth_policies))) then return jsonb_build_object('send',false,'status','frequency_limited'); end if;
 if exists(select 1 from private.agent_lifecycle_emails e where e.email_hash=private.email_hash(c.email) and e.created_at>now()-make_interval(hours=>(select max(min_gap_hours) from private.growth_policies))) then return jsonb_build_object('send',false,'status','frequency_limited'); end if;
 select count(*) into v_n from private.growth_messages where opportunity_id=o.id and purpose='marketing' and attempted_at is not null;
 if m.purpose='marketing' and v_n>=p.max_touches then return jsonb_build_object('send',false,'status','touch_limit'); end if;
 select count(*) into v_n from private.growth_messages x join private.growth_opportunities y on y.id=x.opportunity_id where y.product=o.product and x.attempted_at>=date_trunc('day',now());
 if v_n>=p.daily_limit then return jsonb_build_object('send',false,'status','daily_limit'); end if;
 update private.growth_messages set status='sending',attempted_at=now() where id=m.id;
 return jsonb_build_object('send',true,'to',c.email,'subject',m.subject,'body',m.body,'purpose',m.purpose,'product',o.product,'id',m.id,'workId',m.work_id,'unsubscribeHash',m.unsubscribe_hash);
end; $$;
create function private.growth_finish_message(p_id uuid,p_status text,p_provider text) returns boolean
language plpgsql security definer set search_path='' as $$ begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 if p_status not in ('accepted','failed','unknown') then raise exception 'Invalid delivery' using errcode='22023'; end if;
 update private.growth_messages set status=case when status='sending' then p_status else status end,provider_id=p_provider where id=p_id and status in ('sending','delivered') and attempted_at is not null;
 if not found then return false; end if;
 update private.growth_opportunities o set stage=case when p_status='accepted' and o.stage='qualified' then 'contacted' else o.stage end,
 next_action=case when p_status='accepted' then 'Check reply and agreed next step' else 'Review unconfirmed or refused delivery' end,
 next_at=now()+case when p_status='accepted' then interval '4 days' else interval '1 hour' end,version=version+1,updated_at=now()
 from private.growth_messages m where m.id=p_id and o.id=m.opportunity_id and o.version=m.opportunity_version;
 return true;
end; $$;
create function private.growth_delivery_event(p_event text,p_message uuid,p_kind text,p_at timestamptz) returns boolean
language plpgsql security definer set search_path='' as $$ declare v_contact uuid; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 insert into private.growth_delivery_events(event_id,message_id,kind,occurred_at) values(p_event,p_message,p_kind,p_at) on conflict do nothing;
 if not found then return false; end if;
 if p_kind in ('bounced','complaint','unsubscribe') then
  select contact_id into v_contact from private.growth_messages where id=p_message;
  update private.growth_contacts set eligibility='opted_out',version=version+1 where id=v_contact;
  insert into private.email_suppressions(email_hash) select encode(extensions.digest(email,'sha256'),'hex') from private.growth_contacts where id=v_contact on conflict do nothing;
  update private.growth_messages set status='cancelled' where contact_id=v_contact and status in ('draft','proposed');
 end if;
 update private.growth_messages set status=case when p_kind='unsubscribe' then 'cancelled' else p_kind end,delivered_at=case when p_kind='delivered' then p_at else delivered_at end where id=p_message
 and (p_kind<>'delivered' or status in ('accepted','unknown','sending','delivered'));
 return true;
end; $$;
create function private.growth_unsubscribe(p_hash text) returns boolean
language plpgsql security definer set search_path='' as $$ declare v_id uuid; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0)); select id into v_id from private.growth_messages where unsubscribe_hash=p_hash order by created_at desc limit 1;
 if v_id is null then return false; end if;
 perform private.growth_delivery_event('unsubscribe:'||v_id::text,v_id,'unsubscribe',now()); return true;
end; $$;

-- Deferrals share a durable clock across replicas. Both listing and starting enforce it.
create function private.growth_defer_action(p_id uuid,p_execution integer) returns boolean
language plpgsql security definer set search_path='' as $$ declare v_deferred boolean; begin
 perform private.require_hub_app_server();
 update private.agent_actions set status=case when decided_by is null then 'auto_approved' else 'approved' end,
 executing_at=null,not_before=now()+interval '15 minutes',updated_at=now()
 where id=p_id and kind='growth.message' and status='executing' and executions=p_execution
 returning true into v_deferred;
 return coalesce(v_deferred,false);
end; $$;

create or replace function private.agent_actions_ready(p_limit integer,p_kinds text[],p_exclude_kinds text[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$ begin
 perform private.require_hub_app_server();
 if p_limit is null or p_limit<1 or p_limit>50 then raise exception 'List between 1 and 50 actions.' using errcode='22023'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'agentKey',x.agent_key) order by x.created_at,x.id),'[]'::jsonb)
 from (select a.id,a.kind,a.agent_key,a.created_at from private.agent_actions a
   where a.status in ('approved','auto_approved') and (a.not_before is null or a.not_before<=now())
   and (p_kinds is null or a.kind=any(p_kinds)) and (p_exclude_kinds is null or a.kind<>all(p_exclude_kinds))
   and not exists(select 1 from private.agent_tasks t where t.id=a.task_id and t.status='cancelled')
   order by a.created_at,a.id limit p_limit) x);
end; $$;

create or replace function private.agent_action_execution(p_action_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$ declare v_action private.agent_actions%rowtype; begin
 perform private.require_hub_app_server();
 update private.agent_actions a set status='executing',executing_at=now(),executions=a.executions+1,not_before=null,updated_at=now()
 where a.id=p_action_id and a.status in ('approved','auto_approved') and (a.not_before is null or a.not_before<=now())
 and not exists(select 1 from private.agent_tasks t where t.id=a.task_id and t.status='cancelled') returning a.* into v_action;
 if not found then return null; end if;
 return jsonb_build_object('id',v_action.id,'agentKey',v_action.agent_key,'taskId',v_action.task_id,'kind',v_action.kind,
   'targetKind',v_action.target_kind,'targetId',v_action.target_id,'input',v_action.input,'requestKey',v_action.request_key,
   'autoApproved',v_action.decided_by is null,'execution',v_action.executions);
end; $$;

-- Complete, bounded paging for the account report, preserving its existing snapshot fields.
alter function private.agent_accounts_json(integer) rename to agent_accounts_json_legacy;
create function private.agent_accounts_page_json(p_limit integer,p_offset integer) returns jsonb
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
    'truncated', v_total > p_offset + p_limit,
    'coupons', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.stripe_coupon_id, 'percent_off', c.percent_off, 'amount_off', c.amount_off, 'applies_to', to_jsonb(c.applies_to_products)) order by c.stripe_coupon_id), '[]'::jsonb)
      from private.billing_coupons c where not c.deleted and (v_live is null or c.livemode = v_live)),
    'accounts', (select coalesce(jsonb_agg(a.account order by a.name, a.id), '[]'::jsonb) from (
      select t.id, t.name, jsonb_build_object(
        'slug', t.slug, 'name', t.name, 'status', t.status, 'createdAt', t.created_at,
        'activity',private.growth_account_activity(t.id),
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
      limit p_limit offset p_offset) a));
end;
$$;


create function private.agent_accounts_page(p_limit integer,p_offset integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; begin
 perform private.require_hub_app_server();
 if p_limit is null or p_limit<1 or p_limit>500 or p_offset is null or p_offset<0 then raise exception 'Invalid page' using errcode='22023'; end if;
 -- The internal helper accepts the complete population; only one bounded page leaves this function.
 return private.agent_accounts_page_json(p_limit,p_offset);
end; $$;
-- Existing signatures and release checks remain intact.
create function private.agent_accounts_json(p_limit integer) returns jsonb language sql stable set search_path='' as $$ select private.agent_accounts_json_legacy(p_limit); $$;
create function private.growth_notification_status(p_key text) returns text language plpgsql stable security definer set search_path='' as $$ begin perform private.require_hub_app_server(); return(select status from private.owner_notifications where dedupe_key=p_key and channel='email'); end; $$;

do $$ declare n text; f record; begin
 foreach n in array array['growth_organizations','growth_contacts','growth_opportunities','growth_evidence','customer_activity_events','customer_success_plans','growth_policies','growth_messages','growth_delivery_events','agent_evaluations'] loop
  execute format('alter table private.%I enable row level security',n);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role,hub_app_server',n);
 end loop;
 for f in select p.oid::regprocedure as signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and (p.proname like 'growth_%' or p.proname in ('agent_accounts_page','agent_accounts_json','agent_accounts_json_legacy','agent_accounts_page_json')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,hub_app_server',f.signature);
  if f.proname not in ('growth_overview','agent_accounts_json','agent_accounts_json_legacy','agent_accounts_page_json') then execute format('grant execute on function %s to hub_app_server',f.signature); end if;
 end loop;
end; $$;
revoke all on function hub.growth_workspace(integer),hub.growth_manage(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function hub.growth_workspace(integer),hub.growth_manage(text,jsonb) to authenticated,hub_app_server;


create function private.growth_propose(p_task uuid,p_message uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m private.growth_messages%rowtype; a jsonb; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0)); select * into m from private.growth_messages where id=p_message for update;
 if m.status not in ('draft','proposed') then return null; end if;
 if m.action_id is not null then return jsonb_build_object('id',m.action_id); end if;
 a:=private.agent_action_propose(p_task,null,'growth.message','growth_message',m.id::text,m.subject||E'\n\n'||m.body,jsonb_build_object('messageId',m.id));
 -- Model text always needs exact-message review. Template autonomy additionally needs the product policy.
 if m.model_generated or not exists(select 1 from private.growth_policies p join private.growth_opportunities o on o.product=p.product where o.id=m.opportunity_id and p.auto_send) then
  update private.agent_actions set status='proposed' where id=(a->>'id')::uuid and status='auto_approved';
 end if;
 update private.growth_messages set action_id=(a->>'id')::uuid,status='proposed' where id=m.id;
 return a;
end; $$;
create function hub.growth_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$ begin
 perform hub.authorize_app_admin();
 return jsonb_build_object('evidence',(select coalesce(jsonb_agg(to_jsonb(e)),'[]') from private.growth_evidence e where opportunity_id=p_id),
 'messages',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select id,subject,body,status,citations,model_generated,variant,created_at,attempted_at,delivered_at from private.growth_messages where opportunity_id=p_id order by created_at desc limit 50) x),
 'events',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select e.kind,e.occurred_at,e.facts from private.customer_activity_events e join private.growth_opportunities o on o.organization_id=e.organization_id and o.product=e.product where o.id=p_id order by e.occurred_at desc limit 100) x));
end; $$;
create function private.growth_discover(p_product text,p_rows jsonb) returns integer
language plpgsql security definer set search_path='' as $$ declare r jsonb; v_org uuid; v_opp uuid; v_n integer:=0; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 if p_product not in ('carebase','caremetric-intel') or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>10 then raise exception 'Invalid discovery' using errcode='22023'; end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  insert into private.growth_organizations(name,domain) values(left(r->>'name',200),r->>'domain') on conflict(domain) do nothing;
  select id into v_org from private.growth_organizations where domain=r->>'domain';
  insert into private.growth_opportunities(organization_id,product) values(v_org,p_product) on conflict do nothing;
  select id into v_opp from private.growth_opportunities where organization_id=v_org and product=p_product;
  insert into private.growth_evidence(opportunity_id,source_url,claim,confidence,observed_at) values(v_opp,r->>'url',left(r->>'claim',4000),'low',now()) on conflict do nothing;
  v_n:=v_n+1;
 end loop;
 return v_n;
end; $$;
create function private.growth_inquiry(p_id uuid) returns integer
language plpgsql security definer set search_path='' as $$
declare c private.communications%rowtype; m private.communication_messages%rowtype; v_product text; v_org uuid; v_contact uuid; v_opp uuid; v_message uuid; v_body text; v_reply text; v_n integer:=0; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 select * into m from private.communication_messages where id=p_id and direction='inbound';
 -- Only email webhook ingestion binds this message to its sender. Chat and form addresses are visitor claims.
 -- Check the message, not the thread: a verified email can join a thread originally opened through a public form.
 if not found or m.provider_message_id is null or m.provider_message_id not like 'email:%' then return 0; end if;
 select * into c from private.communications where id=m.communication_id;
 if not found or c.contact_email is null then return 0; end if;
 select id,organization_id into v_contact,v_org from private.growth_contacts where email=lower(btrim(c.contact_email));
 select slug into v_product from hub.products where id=c.product_id;
 v_message:=m.id; v_body:=m.body;
 if v_org is null and v_product in ('carebase','caremetric-intel') and (c.inquiry_type='sales' or v_body ~* '\m(demo|pricing|purchase|interested|buy)\M') and split_part(lower(c.contact_email),'@',2) not in ('gmail.com','outlook.com','hotmail.com','yahoo.com','icloud.com','aol.com','comcast.net') then
  insert into private.growth_organizations(name,domain) values(coalesce(nullif(c.organization,''),'Inbound organization'),split_part(lower(c.contact_email),'@',2)) on conflict(domain) do nothing;
  select id into v_org from private.growth_organizations where domain=split_part(lower(c.contact_email),'@',2);
  insert into private.growth_contacts(organization_id,email,name) values(v_org,lower(btrim(c.contact_email)),coalesce(c.contact_name,'')) on conflict(email) do nothing;
  select id into v_contact from private.growth_contacts where email=lower(btrim(c.contact_email));
  insert into private.growth_opportunities(organization_id,product,contact_id,stage,next_action) values(v_org,v_product,v_contact,'engaged','Respond to inbound inquiry') on conflict do nothing;
 end if;
 if v_org is null then return 0; end if;
 v_reply:=case when v_body ~* '\m(cancel (my|our|the) (account|subscription|service)|close my account|want to cancel)\M' then 'cancel_requested' when v_body ~* '\m(not interested|no thanks)\M' then 'negative_reply' when v_body ~* '\m(not now|next quarter|contact me later)\M' then 'not_now' when v_body ~* '\m(interested|book a demo|schedule a demo)\M' then 'positive_reply' else 'reply' end;
 if v_body ~* '\m(unsubscribe|do not contact|stop emailing|remove me)\M' then
  update private.growth_contacts set eligibility='opted_out',version=version+1 where id=v_contact;
  insert into private.email_suppressions(email_hash) values(encode(extensions.digest(lower(btrim(c.contact_email)),'sha256'),'hex')) on conflict do nothing;
 end if;
 -- Any reply stops contact-level sequences across both products. No conversation text is copied.
 update private.growth_messages set status='cancelled' where contact_id=v_contact and status in ('draft','proposed');
 for v_opp in select id from private.growth_opportunities where organization_id=v_org loop
  insert into private.customer_activity_events(product,organization_id,event_key,kind,occurred_at,facts)
  select product,organization_id,'inquiry:'||v_message::text,v_reply,m.created_at,jsonb_build_object('communicationId',c.id) from private.growth_opportunities where id=v_opp on conflict do nothing;
  if found then
   update private.growth_opportunities set owner_agent=case when v_reply='cancel_requested' then 'account_manager' else owner_agent end,stage=case when v_reply in ('not_now','negative_reply') and stage in ('identified','researched','qualified','contacted','engaged') then 'nurture' when stage in ('identified','researched','qualified','contacted') then 'engaged' else stage end,next_action='Review the customer reply in Communications',next_at=now(),version=version+1,updated_at=now() where id=v_opp;
   perform private.growth_plan(v_opp,jsonb_build_object('key','reply:'||v_message::text,'kind',case when v_reply='cancel_requested' then 'recovery' else 'reply' end,'action',case when v_reply='cancel_requested' then 'Review cancellation concerns in Communications and agree a recovery plan.' else 'Review the customer reply in Communications and agree a next step.' end,'success','The customer question is resolved and the next step recorded.','owner',(select owner_agent from private.growth_opportunities where id=v_opp),'dueAt',now()));
   v_n:=v_n+1;
  end if;
 end loop;
 return v_n;
end; $$;
create function private.growth_evaluate(p_product text,p_version text,p_passed boolean,p_results jsonb) returns void
language plpgsql security definer set search_path='' as $$ begin perform private.require_hub_app_server(); insert into private.agent_evaluations(product,version,passed,results) values(p_product,p_version,p_passed,p_results); end; $$;
insert into private.agent_schedules(agent_key,task_kind,cadence,at_local,timezone,requires_session,next_run_at)
values('marketing_manager','growth.discovery','daily','08:00','America/New_York',false,now()) on conflict do nothing;
revoke all on function private.growth_propose(uuid,uuid),private.growth_discover(text,jsonb),private.growth_inquiry(uuid),private.growth_evaluate(text,text,boolean,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.growth_propose(uuid,uuid),private.growth_discover(text,jsonb),private.growth_inquiry(uuid),private.growth_evaluate(text,text,boolean,jsonb) to hub_app_server;
revoke all on function hub.growth_detail(uuid) from public,anon,authenticated,service_role;
grant execute on function hub.growth_detail(uuid) to authenticated,hub_app_server;
create function hub.growth_research_target(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
 perform hub.authorize_app_command(); return(select jsonb_build_object('product',o.product,'domain',g.domain) from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id where o.id=p_id);
end; $$;
revoke all on function hub.growth_research_target(uuid) from public,anon,authenticated,service_role;
grant execute on function hub.growth_research_target(uuid) to authenticated,hub_app_server;
-- Reply capture runs in the same transaction as the inbox write: a new reply cancels queued outreach before another claim.
create function private.growth_inbound_trigger() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if new.direction='inbound' and session_user='hub_app_server' then perform private.growth_inquiry(new.id); end if; return new;
end; $$;
revoke all on function private.growth_inbound_trigger() from public,anon,authenticated,service_role,hub_app_server;
create trigger growth_inbound after insert on private.communication_messages for each row execute function private.growth_inbound_trigger();
-- Reserve model spend in Postgres as well as in process, so multiple replicas share the cap.
create table private.agent_budget_reservations(id uuid primary key default gen_random_uuid(),agent_key text not null references private.agents(key),task_id uuid not null references private.agent_tasks(id),day_start timestamptz not null,cents numeric not null check(cents>=0),created_at timestamptz not null default now());
alter table private.agent_budget_reservations enable row level security;
revoke all on private.agent_budget_reservations from public,anon,authenticated,service_role,hub_app_server;
create function private.growth_budget_reserve(p_task uuid,p_cents numeric) returns uuid
language plpgsql security definer set search_path='' as $$ declare a private.agents%rowtype; v_id uuid; v_held numeric; begin
 perform private.require_hub_app_server();
 if p_cents is null or p_cents<0 or p_cents>100000 then raise exception 'Invalid reserve' using errcode='22023'; end if;
 select a1.* into a from private.agents a1 join private.agent_tasks t on t.agent_key=a1.key where t.id=p_task and t.status='running' and t.lease_until>now() for update of a1;
 if not found or a.status<>'active' then return null; end if;
 select coalesce(sum(cents),0) into v_held from private.agent_budget_reservations where agent_key=a.key and day_start=private.agent_day_start();
 if private.agent_spent_today_cents(a.key)+v_held+p_cents>a.daily_budget_cents then return null; end if;
 insert into private.agent_budget_reservations(agent_key,task_id,day_start,cents) values(a.key,p_task,private.agent_day_start(),p_cents) returning id into v_id; return v_id;
end; $$;
create function private.growth_budget_release(p_id uuid) returns void language plpgsql security definer set search_path='' as $$ begin perform private.require_hub_app_server(); delete from private.agent_budget_reservations where id=p_id; end; $$;
revoke all on function private.growth_budget_reserve(uuid,numeric),private.growth_budget_release(uuid) from public,anon,authenticated,service_role;
grant execute on function private.growth_budget_reserve(uuid,numeric),private.growth_budget_release(uuid) to hub_app_server;
create function private.growth_brief_counts() returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
 perform private.require_hub_app_server();
 return jsonb_build_object('overdue',(select count(*) from private.customer_success_plans where status='open' and due_at<now()),
 'prospects',(select count(*) from private.growth_opportunities where stage in ('identified','researched','qualified','contacted','engaged','demo')),
 'trials',(select count(*) from private.growth_opportunities where stage='trial'),
 'activated',(select count(*) from private.growth_opportunities where activated_at is not null),
 'paid',(select count(*) from private.growth_opportunities where paid_at is not null),
 'missingContact',(select count(*) from private.growth_opportunities where contact_id is null),
 'unmappedTenants',(select count(*) from hub.tenants t where exists(select 1 from private.billing_customers c where c.tenant_id=t.id and not c.deleted) and not exists(select 1 from private.growth_organizations g where g.tenant_id=t.id)));
end; $$;
revoke all on function private.growth_brief_counts() from public,anon,authenticated,service_role;
grant execute on function private.growth_brief_counts() to hub_app_server;
create function private.growth_maintenance() returns integer language plpgsql security definer set search_path='' as $$ declare n integer; v_actions uuid[]; v_tasks uuid[]; v_task uuid; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 update private.growth_messages set status='unknown' where status='sending' and attempted_at<now()-interval '10 minutes'; get diagnostics n=row_count;
 -- Reconcile before the worker reads its snapshot. Cancel only unsent drafts; never repeat an accepted or uncertain send.
 update private.growth_messages m set status='cancelled'
 from private.growth_opportunities o,private.growth_contacts c,private.growth_policies p
 where m.opportunity_id=o.id and m.contact_id=c.id and p.product=o.product and m.status in ('draft','proposed')
 and (m.opportunity_version<>o.version or m.contact_version<>c.version or m.policy_version<>p.version
   or not exists(select 1 from private.customer_success_plans w where w.id=m.work_id and w.status='open'));
 select array_agg(a.id),array_agg(distinct a.task_id) into v_actions,v_tasks
 from private.agent_actions a join private.growth_messages m on m.action_id=a.id
 where m.status='cancelled' and a.status in ('proposed','approved','auto_approved');
 -- Owner decisions and cancellation lock tasks before actions; keep the same order here.
 perform 1 from private.agent_tasks where id=any(v_tasks) order by id for update;
 update private.agent_actions set status='expired',result=jsonb_build_object('reason','growth_draft_changed'),updated_at=now()
 where id=any(v_actions) and status in ('proposed','approved','auto_approved');
 for v_task in select id from private.agent_tasks where id=any(v_tasks) order by id loop
  perform private.agent_close_task_if_settled(v_task);
 end loop;
 delete from private.agent_budget_reservations where day_start<private.agent_day_start()-interval '7 days';
 return n;
end; $$;
revoke all on function private.growth_maintenance() from public,anon,authenticated,service_role;
grant execute on function private.growth_maintenance() to hub_app_server;
alter table private.growth_opportunities add column assessed_at timestamptz;
create function private.growth_assess(p_id uuid,p_data jsonb) returns boolean language plpgsql security definer set search_path='' as $$ begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 if not exists(select 1 from private.growth_evidence where opportunity_id=p_id and observed_at>now()-interval '30 days') or jsonb_array_length(p_data->'citations')=0
 or exists(select 1 from jsonb_array_elements_text(p_data->'citations') c where not exists(select 1 from private.growth_evidence e where e.opportunity_id=p_id and e.id::text=c)) then raise exception 'Assessment lacks evidence' using errcode='22023'; end if;
 update private.growth_opportunities set fit=(p_data->>'fit')::integer,intent=(p_data->>'intent')::integer,
 memory=memory||jsonb_build_object('researchRationale',p_data->>'rationale','researchCitations',p_data->'citations'),
 stage=case when stage='identified' then 'researched' else stage end,next_action=p_data->>'nextAction',assessed_at=now(),version=version+1,updated_at=now()
 where id=p_id and version=(p_data->>'version')::integer;
 return found;
end; $$;
revoke all on function private.growth_assess(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.growth_assess(uuid,jsonb) to hub_app_server;

-- Search-backed content briefs go to the existing approval queue; no website is published automatically.
create function private.growth_content_context(p_week text) returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
 perform private.require_hub_app_server();
 return jsonb_build_object('policies',(select jsonb_agg(to_jsonb(p)) from private.growth_policies p),'planned',exists(select 1 from private.agent_tasks where kind='growth.content' and result->>'contentWeek'=p_week and (result->>'proposals')::integer>0));
end; $$;
create function private.growth_propose_content(p_task uuid,p_product text,p_data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$ declare a jsonb; begin
 perform private.require_hub_app_server();
 if p_product not in ('carebase','caremetric-intel') or pg_column_size(p_data)>12000 then raise exception 'Invalid brief' using errcode='22023'; end if;
 a:=private.agent_action_propose(p_task,null,'growth.content','growth_content',p_product,p_data->>'title'||E'\n\n'||'Target question: '||(p_data->>'keyword')||E'\n'||(select string_agg(value,E'\n') from jsonb_array_elements_text(p_data->'outline'))||E'\n\nSources:\n'||(select string_agg(value,E'\n') from jsonb_array_elements_text(p_data->'citations'))||E'\n\nCampaign: '||(p_data->>'campaign'),p_data||jsonb_build_object('product',p_product));
 update private.agent_actions set status='proposed' where id=(a->>'id')::uuid and status='auto_approved'; return a;
end; $$;
revoke all on function private.growth_content_context(text),private.growth_propose_content(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.growth_content_context(text),private.growth_propose_content(uuid,text,jsonb) to hub_app_server;
insert into private.agent_schedules(agent_key,task_kind,cadence,at_local,timezone,requires_session,next_run_at)
values('seo_analyst','growth.content','daily','08:30','America/New_York',false,now()) on conflict do nothing;

create index growth_messages_opportunity on private.growth_messages(opportunity_id,attempted_at desc);
create index growth_work_due on private.customer_success_plans(due_at,id) where status='open';
create index growth_evaluations_latest on private.agent_evaluations(product,version,created_at desc);
create index growth_reservations_day on private.agent_budget_reservations(agent_key,day_start);

-- Adoption is separate from billing units. Comparable windows require feed coverage in both weeks.
create function private.growth_account_activity(p_tenant uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_agg(jsonb_build_object('app',product,'metric','active_days','latest',recent_active,'latestAt',latest_at,
 'baseline',baseline_active,'baselineAt',case when recent_feed>=7 and baseline_feed>=7 then now()-interval '28 days' end)) from (
 select e.product,max(e.occurred_at) as latest_at,
 count(distinct e.occurred_at::date) filter(where e.kind in ('active','first_value') and e.occurred_at>=now()-interval '7 days') as recent_active,
 count(distinct e.occurred_at::date) filter(where e.kind in ('active','first_value') and e.occurred_at>=now()-interval '35 days' and e.occurred_at<now()-interval '28 days') as baseline_active,
 count(distinct e.occurred_at::date) filter(where e.occurred_at>=now()-interval '7 days') as recent_feed,
 count(distinct e.occurred_at::date) filter(where e.occurred_at>=now()-interval '35 days' and e.occurred_at<now()-interval '28 days') as baseline_feed
 from private.customer_activity_events e join private.growth_organizations g on g.id=e.organization_id
 where g.tenant_id=p_tenant and e.kind in ('heartbeat','active','first_value') and e.occurred_at<=now() and e.occurred_at>now()-interval '90 days' group by e.product) x;
$$;
revoke all on function private.growth_account_activity(uuid) from public,anon,authenticated,service_role,hub_app_server;

-- Coordinate contact frequency with the existing customer-email workflow without changing its approvals or replay rules.
create or replace function private.agent_lifecycle_begin_send(p_action_id uuid, p_execution integer, p_unsubscribe_hash text) returns jsonb
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
  -- Growth and native lifecycle claims share this lock before taking any row lock or send reservation.
  perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
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
  if exists(select 1 from private.growth_messages m join private.growth_contacts c on c.id=m.contact_id
    where c.email=lower(btrim(v_email)) and m.attempted_at>now()-make_interval(hours=>(select max(min_gap_hours) from private.growth_policies))) then
    return jsonb_build_object('state','frequency_limited');
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

create index agent_lifecycle_emails_contact_attempt on private.agent_lifecycle_emails(email_hash,created_at desc);
