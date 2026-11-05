-- Sales follow-ups and capped cold email. The owner chose (2026-11-04) to let the Marketing Manager send its follow-ups and its
-- first-touch emails to businesses found online on its own, each after one supervised week (the autonomy steps "sales_followups"
-- and "cold_email" below), and asked for cold email to be capped: public business role addresses only (info@, contact@ ...), never
-- a text message, at most ten a day across both products, one business contacted once, every email with the unsubscribe link and
-- the postal address the growth sender already adds.
--
-- What changes:
--   1. A contact the Hub's contact finder found on the business's own website is recorded as such (source_kind 'role_address'); the
--      database admits only role local parts for it. The finder may make it permitted for outreach on its own; any other contact
--      stays the owner's decision.
--   2. Rule-based qualification from the assessment the Marketing Manager already writes (fit, dated evidence), with the thresholds
--      in one versioned table.
--   3. Two autonomy steps. Each adds one trust value to the Marketing Manager's auto_approve_kinds: growth.sales_followup (follow-ups
--      and replies to people who contacted CareMetric or that the owner added) and growth.cold_email (outreach to a role address the
--      finder found). Neither is an action kind; the growth operations below read them.
--   4. growth_propose approves a message on its own only for a trusted class (a model-written one included, since it passed the
--      draft checks before it was stored), and growth_claim_message checks that trust again at send time with the agent's row held,
--      plus the cold caps for every cold email however it was approved.
--   5. hub.growth_manage no longer overwrites the agents' auto_approve_kinds when a product policy turns auto-send on: it adds or
--      removes only growth.message, the policy's own value.
--   6. A daily schedule for the growth.1 evaluation that unapproved sends already require (nothing scheduled it).
-- Nothing here sends: sending still needs HUB_GROWTH_SEND_ENABLED=true and the signing key, and every step starts off.

-- ---------------------------------------------------------------------------------------
-- 1. Role addresses found on a business's own website.
-- ---------------------------------------------------------------------------------------
alter table private.growth_contacts add column source_kind text not null default 'owner' check (source_kind in ('owner', 'role_address'));
alter table private.growth_contacts add constraint growth_contacts_role_address_check check (
  source_kind <> 'role_address' or split_part(email, '@', 1) in (
    'info', 'contact', 'contactus', 'office', 'admin', 'administrator', 'hello', 'inquiries', 'inquiry', 'enquiries', 'enquiry',
    'sales', 'admissions', 'reception', 'frontdesk', 'general', 'mail', 'team'));
alter table private.growth_organizations add column discovered_at timestamptz, add column contact_searched_at timestamptz;

-- Discovery stamps the organizations it creates, so the contact finder only ever looks at businesses found online.
create or replace function private.growth_discover(p_product text,p_rows jsonb) returns integer
language plpgsql security definer set search_path='' as $$ declare r jsonb; v_org uuid; v_opp uuid; v_n integer:=0; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 if p_product not in ('carebase','caremetric-intel') or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>10 then raise exception 'Invalid discovery' using errcode='22023'; end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  insert into private.growth_organizations(name,domain,discovered_at) values(left(r->>'name',200),r->>'domain',now()) on conflict(domain) do nothing;
  select id into v_org from private.growth_organizations where domain=r->>'domain';
  insert into private.growth_opportunities(organization_id,product) values(v_org,p_product) on conflict do nothing;
  select id into v_opp from private.growth_opportunities where organization_id=v_org and product=p_product;
  insert into private.growth_evidence(opportunity_id,source_url,claim,confidence,observed_at) values(v_opp,r->>'url',left(r->>'claim',4000),'low',now()) on conflict do nothing;
  v_n:=v_n+1;
 end loop;
 return v_n;
end; $$;

-- Server: discovered businesses with an opportunity but no contact, not searched in the last 90 days.
create function private.growth_contact_candidates(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$ begin
 perform private.require_hub_app_server();
 if p_limit is null or p_limit<1 or p_limit>20 then raise exception 'Invalid page' using errcode='22023'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'domain',x.domain) order by x.discovered_at,x.id),'[]'::jsonb) from (
  select g.id,g.domain,g.discovered_at from private.growth_organizations g
  where g.discovered_at is not null and not g.internal and g.tenant_id is null
    and (g.contact_searched_at is null or g.contact_searched_at<now()-interval '90 days')
    and exists(select 1 from private.growth_opportunities o where o.organization_id=g.id and o.contact_id is null and o.stage in ('identified','researched','qualified'))
  order by g.discovered_at,g.id limit p_limit) x);
end; $$;

-- Server: what the contact finder found for one business (p_email null: nothing usable). A found address must be a role address on
-- the business's own domain, found on a page of that domain; it becomes the business's one finder contact, permitted for outreach,
-- and the contact of its opportunities that have none. An address that unsubscribed, or that belongs to another business, is not added.
create function private.growth_record_contact(p_org uuid,p_email text,p_source_url text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g private.growth_organizations%rowtype; v_email text:=lower(btrim(p_email)); v_host text; v_contact private.growth_contacts%rowtype; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 select * into g from private.growth_organizations where id=p_org for update;
 if not found or g.discovered_at is null or g.internal or g.tenant_id is not null then raise exception 'Not a discovered business' using errcode='22023'; end if;
 update private.growth_organizations set contact_searched_at=now() where id=g.id;
 if v_email is null or v_email='' then return jsonb_build_object('found',false,'reason','none'); end if;
 v_host:=lower(split_part(split_part(coalesce(p_source_url,''),'://',2),'/',1));
 if v_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' or split_part(v_email,'@',2)<>g.domain
   or p_source_url !~ '^https://' or char_length(p_source_url)>2000 or v_host not in (g.domain,'www.'||g.domain) then
  raise exception 'A found address must be on the business''s own domain' using errcode='22023';
 end if;
 if exists(select 1 from private.email_suppressions where email_hash=encode(extensions.digest(v_email,'sha256'),'hex')) then
  return jsonb_build_object('found',false,'reason','suppressed');
 end if;
 select * into v_contact from private.growth_contacts where organization_id=g.id and source_kind='role_address' order by created_at,id limit 1;
 if found then
  -- One finder contact per business. Seeing its address again re-verifies it; another one is not added.
  if v_contact.email=v_email then update private.growth_contacts set verified_at=now(),source_url=p_source_url where id=v_contact.id; end if;
 else
  if exists(select 1 from private.growth_contacts where email=v_email) then return jsonb_build_object('found',false,'reason','taken'); end if;
  insert into private.growth_contacts(organization_id,email,name,role,eligibility,verified_at,source_url,source_kind)
  values(g.id,v_email,'','Public business address','permitted',now(),p_source_url,'role_address') returning * into v_contact;
 end if;
 update private.growth_opportunities set contact_id=v_contact.id,version=version+1,updated_at=now() where organization_id=g.id and contact_id is null;
 insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
 values(null,'growth.role_contact_found','growth',g.id,jsonb_build_object('contact',v_contact.id,'eligibility',v_contact.eligibility));
 return jsonb_build_object('found',true,'contactId',v_contact.id);
end; $$;

-- ---------------------------------------------------------------------------------------
-- 2. Rule-based qualification. One active rule set; its version is recorded on every opportunity it qualifies.
-- ---------------------------------------------------------------------------------------
create table private.growth_qualification_rules (
 version text primary key check (version ~ '^qualify\.[0-9]{1,3}$'), active boolean not null default false,
 min_fit integer not null check (min_fit between 50 and 100), min_fresh_evidence integer not null check (min_fresh_evidence between 1 and 10),
 evidence_days integer not null check (evidence_days between 1 and 30), created_at timestamptz not null default now()
);
create unique index growth_qualification_rules_active on private.growth_qualification_rules ((true)) where active;
alter table private.growth_qualification_rules enable row level security;
revoke all on private.growth_qualification_rules from public, anon, authenticated, service_role, hub_app_server;
insert into private.growth_qualification_rules(version,active,min_fit,min_fresh_evidence,evidence_days) values ('qualify.1',true,75,1,30) on conflict do nothing;

-- Server: researched opportunities whose assessment meets the active rules move to qualified: fit at or above the threshold, assessed
-- and evidenced within the window, a permitted and verified contact that has not unsubscribed, not a customer or internal, and no
-- "not now" or "not interested" from the business. Nothing is sent here.
create function private.growth_auto_qualify(p_limit integer) returns jsonb
language plpgsql security definer set search_path='' as $$ declare r private.growth_qualification_rules%rowtype; v_n integer; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 if p_limit is null or p_limit<1 or p_limit>200 then raise exception 'Invalid page' using errcode='22023'; end if;
 select * into r from private.growth_qualification_rules where active;
 if not found then return jsonb_build_object('qualified',0,'rules',null); end if;
 with chosen as (
  select o.id from private.growth_opportunities o
  join private.growth_organizations g on g.id=o.organization_id
  join private.growth_contacts c on c.id=o.contact_id
  where o.stage='researched' and o.owner_agent='marketing_manager' and o.fit>=r.min_fit and o.assessed_at>now()-make_interval(days=>r.evidence_days)
    and not g.internal and g.tenant_id is null and c.eligibility='permitted' and c.verified_at>now()-interval '90 days'
    and not exists(select 1 from private.email_suppressions s where s.email_hash=encode(extensions.digest(c.email,'sha256'),'hex'))
    and (select count(*) from private.growth_evidence e where e.opportunity_id=o.id and e.source_url ~ '^https://'
         and e.observed_at between now()-make_interval(days=>r.evidence_days) and now())>=r.min_fresh_evidence
    and not exists(select 1 from private.customer_activity_events e where e.organization_id=o.organization_id and e.kind in ('negative_reply','not_now'))
  order by o.assessed_at,o.id limit p_limit for update of o)
 update private.growth_opportunities o set stage='qualified',memory=o.memory||jsonb_build_object('qualifiedBy',r.version,'qualifiedAt',now()),
  next_action='Offer one relevant next step based on verified product fit',next_at=now(),version=o.version+1,updated_at=now()
 from chosen where o.id=chosen.id;
 get diagnostics v_n=row_count;
 if v_n>0 then insert into private.audit_events(actor_id,action,entity_type,metadata) values(null,'growth.auto_qualified','growth',jsonb_build_object('rules',r.version,'count',v_n)); end if;
 return jsonb_build_object('qualified',v_n,'rules',r.version);
end; $$;

-- ---------------------------------------------------------------------------------------
-- 3. The two autonomy steps, and the daily evaluation.
-- ---------------------------------------------------------------------------------------
insert into private.agent_autonomy_steps (category, label, requires_feature, changes) values
  ('sales_followups', 'Sales follow-ups', 'platform.agents.growth-autonomy.v1',
    '[{"agent": "marketing_manager", "config_key": "auto_approve_kinds", "values": ["growth.sales_followup"]}]'),
  ('cold_email', 'Cold email', 'platform.agents.growth-autonomy.v1',
    '[{"agent": "marketing_manager", "config_key": "auto_approve_kinds", "values": ["growth.cold_email"]}]')
on conflict (category) do nothing;

insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('marketing_manager', 'growth.evaluate', 'daily', null, '06:40', 'America/New_York', false,
  private.agent_schedule_next('daily', null, '06:40', 'America/New_York', now(), null))
on conflict (agent_key, task_kind) do nothing;

-- The trust class of a Marketing Manager message: outreach to a role address the finder found is cold email; anything else it sends
-- (outreach to a contact the owner added or who wrote in, and every reply follow-up) is a sales follow-up. Other agents' messages
-- have no class and keep the product policy's rules.
create function private.growth_message_class(p_agent text,p_purpose text,p_source_kind text) returns text
language sql immutable set search_path='' as $$
 select case when p_agent='marketing_manager' and p_purpose='marketing' and p_source_kind='role_address' then 'growth.cold_email'
             when p_agent='marketing_manager' then 'growth.sales_followup' end;
$$;

-- A message withdrawn because the owner took the hand-over back, or paused the agent or moved it to Observe, is kept (cancelled, with
-- withdrawn_at) but no longer holds its work's draft key, so the next sweep drafts that work again: for the owner to approve, or on its
-- own once the hand-over is given again. Any other cancellation keeps the key, so unchanged work is not drafted (and paid for) again.
alter table private.growth_messages add column if not exists withdrawn_at timestamptz;
do $$
declare v_name text;
begin
  select conname into v_name from pg_constraint where conrelid = 'private.growth_messages'::regclass and contype = 'u'
    and pg_get_constraintdef(oid) = 'UNIQUE (work_id, opportunity_version, contact_version, policy_version)';
  if v_name is not null then execute format('alter table private.growth_messages drop constraint %I', v_name); end if;
end $$;
create unique index if not exists growth_messages_draft_key on private.growth_messages(work_id, opportunity_version, contact_version, policy_version)
  where withdrawn_at is null;

create or replace function private.growth_draft(p_opportunity uuid,p_work uuid,p_data jsonb) returns jsonb
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
 on conflict(work_id,opportunity_version,contact_version,policy_version) where withdrawn_at is null do nothing returning id into v_id;
 if v_id is null then select id into v_id from private.growth_messages where work_id=p_work and opportunity_version=v_o.version and contact_version=(select version from private.growth_contacts where id=v_o.contact_id) and policy_version=(select version from private.growth_policies where product=v_o.product) and withdrawn_at is null; end if;
 return (select jsonb_build_object('id',id,'subject',subject,'body',body,'status',status,'actionId',action_id) from private.growth_messages where id=v_id);
end; $$;

-- ---------------------------------------------------------------------------------------
-- 4. Proposing and claiming a message.
-- ---------------------------------------------------------------------------------------
create or replace function private.growth_propose(p_task uuid,p_message uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m private.growth_messages%rowtype; a jsonb; v_agent private.agents%rowtype; v_class text; v_trusted boolean; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0)); select * into m from private.growth_messages where id=p_message for update;
 if m.status not in ('draft','proposed') then return null; end if;
 if m.action_id is not null then return jsonb_build_object('id',m.action_id); end if;
 a:=private.agent_action_propose(p_task,null,'growth.message','growth_message',m.id::text,m.subject||E'\n\n'||m.body,jsonb_build_object('messageId',m.id));
 select g.* into v_agent from private.agents g join private.agent_tasks t on t.agent_key=g.key where t.id=p_task;
 v_class:=private.growth_message_class(v_agent.key,m.purpose,(select c.source_kind from private.growth_contacts c where c.id=m.contact_id));
 -- On its own only for a class the owner handed over (autonomy steps): the agent active, on Act, and the class in its list.
 v_trusted:=v_class is not null and v_agent.status='active' and v_agent.autonomy='act'
   and jsonb_typeof(v_agent.config->'auto_approve_kinds')='array' and (v_agent.config->'auto_approve_kinds') ? v_class;
 if v_trusted then
  update private.agent_actions set status='auto_approved',updated_at=now() where id=(a->>'id')::uuid and status='proposed';
 -- Otherwise model text needs exact-message review, cold email needs the owner, and template autonomy needs the product policy.
 elsif m.model_generated or v_class='growth.cold_email' or not exists(select 1 from private.growth_policies p join private.growth_opportunities o on o.product=p.product where o.id=m.opportunity_id and p.auto_send) then
  update private.agent_actions set status='proposed' where id=(a->>'id')::uuid and status='auto_approved';
 end if;
 update private.growth_messages set action_id=(a->>'id')::uuid,status='proposed' where id=m.id;
 return a||jsonb_build_object('status',(select status from private.agent_actions where id=(a->>'id')::uuid));
end; $$;

create or replace function private.growth_claim_message(p_id uuid,p_action uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m private.growth_messages%rowtype; o private.growth_opportunities%rowtype; c private.growth_contacts%rowtype; p private.growth_policies%rowtype; a private.agent_actions%rowtype; g private.agents%rowtype; v_n integer;
 v_class text; v_cold boolean; v_cold_sent integer;
begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 select * into m from private.growth_messages where id=p_id for update;
 if not found then raise exception 'Unknown message' using errcode='22023'; end if;
 if m.status not in ('draft','proposed') then return jsonb_build_object('send',false,'status',m.status); end if;
 select * into a from private.agent_actions where id=p_action;
 -- Held (shared) until this transaction commits, so a pause, a level change or Keep approving cannot slip in between this check and
 -- the claim: either it commits first and the message is refused, or it waits until the message is claimed.
 select * into g from private.agents where key=a.agent_key for share;
 select * into o from private.growth_opportunities where id=m.opportunity_id for update;
 select * into c from private.growth_contacts where id=m.contact_id for update;
 select * into p from private.growth_policies where product=o.product for update;
 if a.id is null or a.id<>m.action_id or a.status<>'executing' or a.kind<>'growth.message' or a.target_id<>m.id::text then raise exception 'Message not authorized' using errcode='42501'; end if;
 -- Paused, or moved to Observe, after the message was approved: one nobody approved is withdrawn like any hand-over taken back (never
 -- sent, and its work is drafted again); one the owner approved is refused as before.
 if g.status<>'active' or g.autonomy='observe' then
  if a.decided_by is null then
   update private.growth_messages set status='cancelled',withdrawn_at=now() where id=m.id; return jsonb_build_object('send',false,'status','outreach_off');
  end if;
  raise exception 'Message not authorized' using errcode='42501';
 end if;
 v_class:=private.growth_message_class(a.agent_key,m.purpose,c.source_kind);
 v_cold:=v_class='growth.cold_email';
 -- Nobody approved it: the agent must still be on Act and trusted with its class now (cold email only through its own step), or,
 -- for a template follow-up, the product policy must still send on its own. Otherwise it is never sent.
 if a.decided_by is null and not (g.autonomy='act' and (
   (v_class is not null and jsonb_typeof(g.config->'auto_approve_kinds')='array' and (g.config->'auto_approve_kinds') ? v_class)
   or (p.auto_send and not m.model_generated and not v_cold))) then
  update private.growth_messages set status='cancelled',withdrawn_at=now() where id=m.id; return jsonb_build_object('send',false,'status','outreach_off');
 end if;
 if not p.enabled or p.version<>m.policy_version or o.version<>m.opportunity_version or c.version<>m.contact_version
 or c.eligibility<>'permitted' or c.verified_at is null or c.verified_at<now()-interval '90 days'
 or exists(select 1 from private.growth_organizations where id=o.organization_id and internal)
 or exists(select 1 from private.email_suppressions where email_hash=encode(extensions.digest(c.email,'sha256'),'hex'))
 or (m.purpose='marketing' and not exists(select 1 from private.growth_evidence e where e.opportunity_id=o.id and e.id::text in(select jsonb_array_elements_text(m.citations)) and e.observed_at between now()-interval '30 days' and now()))
 or o.stage in ('lost','churned','disqualified','nurture')
 or (m.purpose='marketing' and (o.stage not in ('qualified','contacted') or exists(select 1 from private.customer_activity_events e where e.organization_id=o.organization_id and e.kind in ('reply','positive_reply','negative_reply','not_now','meeting_booked','trial_started'))))
 or (v_cold and exists(select 1 from private.growth_organizations where id=o.organization_id and tenant_id is not null))
 or not exists(select 1 from private.customer_success_plans where id=m.work_id and status='open') then
  update private.growth_messages set status='cancelled' where id=m.id; return jsonb_build_object('send',false,'status','cancelled');
 end if;
 -- A business is cold-emailed once: every cold email to it goes to the one contact, for the one opportunity, of its first touch.
 if v_cold and exists(select 1 from private.growth_messages x join private.growth_contacts xc on xc.id=x.contact_id
   where xc.organization_id=c.organization_id and xc.source_kind='role_address' and x.purpose='marketing' and x.attempted_at is not null
     and x.id<>m.id and (x.contact_id<>c.id or x.opportunity_id<>o.id)) then
  update private.growth_messages set status='cancelled' where id=m.id; return jsonb_build_object('send',false,'status','business_contacted');
 end if;
 if a.decided_by is null and coalesce((select e.passed from private.agent_evaluations e where e.product=o.product and e.version='growth.1' and e.created_at>now()-interval '30 days' order by e.created_at desc limit 1),false) is not true then return jsonb_build_object('send',false,'status','evaluation_required'); end if;
 if exists(select 1 from private.growth_messages where contact_id=c.id and id<>m.id and status in ('unknown','sending')) then return jsonb_build_object('send',false,'status','delivery_unresolved'); end if;
 if exists(select 1 from private.growth_messages where contact_id=c.id and attempted_at>now()-make_interval(hours=>(select max(min_gap_hours) from private.growth_policies))) then return jsonb_build_object('send',false,'status','frequency_limited'); end if;
 if exists(select 1 from private.agent_lifecycle_emails e where e.email_hash=private.email_hash(c.email) and e.created_at>now()-make_interval(hours=>(select max(min_gap_hours) from private.growth_policies))) then return jsonb_build_object('send',false,'status','frequency_limited'); end if;
 select count(*) into v_n from private.growth_messages where opportunity_id=o.id and purpose='marketing' and attempted_at is not null;
 if m.purpose='marketing' and v_n>=p.max_touches then return jsonb_build_object('send',false,'status','touch_limit'); end if;
 select count(*) into v_n from private.growth_messages x join private.growth_opportunities y on y.id=x.opportunity_id where y.product=o.product and x.attempted_at>=date_trunc('day',now());
 if v_n>=p.daily_limit then return jsonb_build_object('send',false,'status','daily_limit'); end if;
 -- Cold email: at most ten a day (Eastern) across both products, however each was approved.
 if v_cold then
  select count(*) into v_cold_sent from private.growth_messages x join private.growth_contacts xc on xc.id=x.contact_id
  where xc.source_kind='role_address' and x.purpose='marketing' and x.attempted_at>=private.agent_day_start();
  if v_cold_sent >= 10 then return jsonb_build_object('send',false,'status','daily_limit'); end if;
 end if;
 update private.growth_messages set status='sending',attempted_at=now() where id=m.id;
 return jsonb_build_object('send',true,'to',c.email,'subject',m.subject,'body',m.body,'purpose',m.purpose,'product',o.product,'id',m.id,'workId',m.work_id,'unsubscribeHash',m.unsubscribe_hash);
end; $$;

-- ---------------------------------------------------------------------------------------
-- 5. The owner's growth operations: a policy adds or removes only growth.message, never the rest of an agent's list.
-- ---------------------------------------------------------------------------------------
create or replace function hub.growth_manage(p_operation text,p_data jsonb) returns jsonb
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
  -- growth.message is the policies' own value: listed while any product sends templates on its own, removed when none does. Every
  -- other value on the agents' lists (an autonomy step's included) is left exactly as it was.
  if exists(select 1 from private.growth_policies where auto_send) then
   update private.agents set config=jsonb_set(config,'{auto_approve_kinds}',(select coalesce(jsonb_agg(distinct v order by v),'[]'::jsonb)
     from jsonb_array_elements_text((case when jsonb_typeof(config->'auto_approve_kinds')='array' then config->'auto_approve_kinds' else '[]'::jsonb end)||'["growth.message"]'::jsonb) v)),updated_at=now()
   where key in ('marketing_manager','account_manager') and not coalesce((config->'auto_approve_kinds') ? 'growth.message',false);
  else
   update private.agents set config=jsonb_set(config,'{auto_approve_kinds}',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb)
     from jsonb_array_elements_text(config->'auto_approve_kinds') v where v<>'growth.message')),updated_at=now()
   where key in ('marketing_manager','account_manager') and jsonb_typeof(config->'auto_approve_kinds')='array' and (config->'auto_approve_kinds') ? 'growth.message';
  end if;
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

revoke all on function private.growth_contact_candidates(integer), private.growth_record_contact(uuid,text,text), private.growth_auto_qualify(integer),
  private.growth_propose(uuid,uuid), private.growth_claim_message(uuid,uuid), private.growth_discover(text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.growth_contact_candidates(integer), private.growth_record_contact(uuid,text,text), private.growth_auto_qualify(integer),
  private.growth_propose(uuid,uuid), private.growth_claim_message(uuid,uuid), private.growth_discover(text,jsonb)
  to hub_app_server;
revoke all on function private.growth_message_class(text,text,text) from public, anon, authenticated, service_role, hub_app_server;
revoke all on function hub.growth_manage(text,jsonb) from public, anon, service_role;
grant execute on function hub.growth_manage(text,jsonb) to authenticated, hub_app_server;
