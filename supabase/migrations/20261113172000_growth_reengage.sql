-- One honest second chance, a wider idea of cold email, and the experiment arms each message was written under (owner plan
-- 2026-11-13; AI workforce review 2026-11-12, P1 "nurture is a dead end" and P2 "nothing learns from outcomes").
--
-- 1. private.growth_reengage moves an opportunity back to qualified once, for a single re-ask: after "not now" (or a silent three
--    touches) once Settings -> Customer growth -> "Ask again after 'not now'" days have passed (90 until the owner saves a number),
--    or sooner (14 days after the last touch) when the roster shows its ownership changed since. Never after a negative reply, an
--    opt-out, a trial or a sign-up, and never twice. The memory records when and why, and how many touches came before.
-- 2. private.growth_claim_message reads replies and touches since that re-ask, so the re-ask may be sent and only one: a negative
--    reply, a trial, a sign-up or a meeting still stops it whenever it happened. A sign-up from a website lead now stops cold email
--    too (20261113171000). Everything else in the claim is unchanged, including the owner's cold-email cap.
-- 3. Cold email is outreach to an address the team found (a role address, a contact-data service's address, or an imported one),
--    never to a person who asked: private.growth_message_class, the claim's daily cold count and its once-per-business rule all read
--    the same class, so a found person's address can never escape the cold caps.
-- 4. growth_messages.arms records the experiment arms a message was written under (opener, angle, subject style, length, the trigger
--    the draft used), so outcomes can be compared by arm (server/growth/draft.mjs, the learning memo).
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.recontact_days', 'number')
on conflict (key) do nothing;

create or replace function private.growth_message_class(p_agent text,p_purpose text,p_source_kind text) returns text
language sql immutable set search_path='' as $$
 select case when p_agent='marketing_manager' and p_purpose='marketing' and p_source_kind in ('role_address','enriched','imported') then 'growth.cold_email'
             when p_agent='marketing_manager' then 'growth.sales_followup' end;
$$;
revoke all on function private.growth_message_class(text,text,text) from public,anon,authenticated,service_role,hub_app_server;

alter table private.growth_messages add column if not exists arms jsonb not null default '{}'::jsonb
  check (jsonb_typeof(arms) = 'object' and pg_column_size(arms) <= 600);

create or replace function private.growth_draft(p_opportunity uuid,p_work uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$ declare v_o private.growth_opportunities%rowtype; v_id uuid; v_contact_version integer; v_policy_version integer; v_arms jsonb; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 select * into v_o from private.growth_opportunities where id=p_opportunity for update;
 if not found or v_o.contact_id is null or v_o.version is distinct from (p_data->>'version')::integer then raise exception 'Opportunity changed or lacks contact' using errcode='40001'; end if;
 select version into v_contact_version from private.growth_contacts where id=v_o.contact_id;
 select version into v_policy_version from private.growth_policies where product=v_o.product;
 if v_contact_version is distinct from (p_data->>'contactVersion')::integer or v_policy_version is distinct from (p_data->>'policyVersion')::integer then
  raise exception 'Draft context changed; regenerate from the current contact and policy' using errcode='40001';
 end if;
 if not exists(select 1 from private.customer_success_plans where id=p_work and opportunity_id=p_opportunity and status='open') then raise exception 'Work no longer open' using errcode='40001'; end if;
 -- Arms are short codes only: never text from the message or the prospect.
 v_arms:=coalesce((select jsonb_object_agg(key,value) from jsonb_each_text(case when jsonb_typeof(p_data->'arms')='object' then p_data->'arms' else '{}'::jsonb end)
   where key ~ '^[a-z_]{1,20}$' and value ~ '^[a-z0-9_.-]{1,40}$'),'{}'::jsonb);
 insert into private.growth_messages(opportunity_id,work_id,contact_id,purpose,subject,body,citations,opportunity_version,contact_version,policy_version,unsubscribe_hash,variant,model_generated,arms)
 select v_o.id,p_work,c.id,p_data->>'purpose',p_data->>'subject',p_data->>'body',p_data->'citations',v_o.version,c.version,p.version,p_data->>'unsubscribeHash',coalesce(p_data->>'variant','control'),coalesce((p_data->>'modelGenerated')::boolean,false),v_arms
 from private.growth_contacts c join private.growth_policies p on p.product=v_o.product where c.id=v_o.contact_id
 on conflict(work_id,opportunity_version,contact_version,policy_version) where withdrawn_at is null do nothing returning id into v_id;
 if v_id is null then select id into v_id from private.growth_messages where work_id=p_work and opportunity_version=v_o.version and contact_version=(select version from private.growth_contacts where id=v_o.contact_id) and policy_version=(select version from private.growth_policies where product=v_o.product) and withdrawn_at is null; end if;
 return (select jsonb_build_object('id',id,'subject',subject,'body',body,'status',status,'actionId',action_id) from private.growth_messages where id=v_id);
end; $$;

-- The owner's wait before a re-ask: the saved whole number of days, held to 30..365, or 90.
create function private.growth_recontact_days() returns integer
language sql stable set search_path = '' as $$
  select coalesce((select case when jsonb_typeof(s.value) = 'number' and (s.value #>> '{}') ~ '^[0-9]{1,9}$'
    then least(greatest((s.value #>> '{}')::integer, 30), 365) end from private.hub_settings s where s.key = 'growth.recontact_days'), 90);
$$;
revoke all on function private.growth_recontact_days() from public, anon, authenticated, service_role, hub_app_server;

-- Server (the Marketing Manager's sweep): opportunities due their one re-ask, moved back to qualified. Nothing is sent here.
create function private.growth_reengage(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_days integer := private.growth_recontact_days(); v_n integer; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_limit is null or p_limit < 1 or p_limit > 200 then raise exception 'Invalid page' using errcode = '22023'; end if;
 with facts as (
   select o.id, o.organization_id, o.stage,
     (select max(m.attempted_at) from private.growth_messages m where m.opportunity_id = o.id and m.purpose = 'marketing' and m.attempted_at is not null) as last_touch,
     (select count(*) from private.growth_messages m where m.opportunity_id = o.id and m.purpose = 'marketing' and m.attempted_at is not null) as touches,
     (select e.kind from private.customer_activity_events e where e.organization_id = o.organization_id
        and e.kind in ('reply', 'positive_reply', 'negative_reply', 'not_now') order by e.occurred_at desc limit 1) as last_reply,
     (select max(e.occurred_at) from private.customer_activity_events e where e.organization_id = o.organization_id
        and e.kind in ('reply', 'positive_reply', 'negative_reply', 'not_now')) as replied_at,
     (select max((t.facts ->> 'ownershipChanged')::date) from private.growth_roster_targets t where t.organization_id = o.organization_id
        and t.facts ->> 'ownershipChanged' ~ '^\d{4}-\d{2}-\d{2}$') as ownership_changed,
     p.max_touches
   from private.growth_opportunities o
   join private.growth_organizations g on g.id = o.organization_id
   join private.growth_contacts c on c.id = o.contact_id
   join private.growth_policies p on p.product = o.product
   where o.owner_agent = 'marketing_manager' and o.stage in ('nurture', 'contacted') and not (o.memory ? 'reengagedAt')
     and not g.internal and g.tenant_id is null and c.eligibility = 'permitted'
     and not exists (select 1 from private.email_suppressions s where s.email_hash = encode(extensions.digest(c.email, 'sha256'), 'hex'))
     and not exists (select 1 from private.customer_activity_events e where e.organization_id = o.organization_id
       and e.kind in ('negative_reply', 'cancel_requested', 'trial_started', 'signup', 'paid', 'meeting_booked'))),
 due as (
   select f.*, case
     when f.ownership_changed is not null and f.last_touch is not null and f.ownership_changed > f.last_touch::date and f.last_touch < now() - interval '14 days' then 'new_owner'
     when f.last_reply = 'not_now' and f.replied_at < now() - make_interval(days => v_days) then 'not_now'
     when f.last_reply is null and f.stage = 'contacted' and f.touches >= f.max_touches and f.last_touch < now() - make_interval(days => v_days) then 'silent'
   end as why
   from facts f),
 chosen as (select d.* from due d where d.why is not null order by d.last_touch nulls first, d.id limit p_limit)
 update private.growth_opportunities o set stage = 'qualified',
   memory = o.memory || jsonb_build_object('reengagedAt', now(), 'reengageReason', chosen.why, 'touchesBefore', chosen.touches),
   next_action = 'Ask once more, briefly', next_at = now(), version = o.version + 1, updated_at = now()
 from chosen where o.id = chosen.id;
 get diagnostics v_n = row_count;
 if v_n > 0 then insert into private.audit_events(actor_id, action, entity_type, metadata) values (null, 'growth.reengaged', 'growth', jsonb_build_object('count', v_n, 'days', v_days)); end if;
 return jsonb_build_object('reengaged', v_n, 'days', v_days);
end; $$;
revoke all on function private.growth_reengage(integer) from public, anon, authenticated, service_role;
grant execute on function private.growth_reengage(integer) to hub_app_server;

CREATE OR REPLACE FUNCTION private.growth_claim_message(p_id uuid, p_action uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m private.growth_messages%rowtype; o private.growth_opportunities%rowtype; c private.growth_contacts%rowtype; p private.growth_policies%rowtype; a private.agent_actions%rowtype; g private.agents%rowtype; v_n integer;
 v_class text; v_cold boolean; v_cold_sent integer; v_cap integer; v_since timestamptz;
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
 -- A re-ask (private.growth_reengage) reads replies and touches since it began; a negative reply, a trial, a sign-up or a meeting
 -- stops outreach whenever it happened.
 v_since:=case when o.memory ? 'reengagedAt' and (o.memory->>'reengagedAt') ~ '^\d{4}-' then (o.memory->>'reengagedAt')::timestamptz else '-infinity'::timestamptz end;
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
 or (m.purpose='marketing' and (o.stage not in ('qualified','contacted') or exists(select 1 from private.customer_activity_events e where e.organization_id=o.organization_id
     and (e.kind in ('negative_reply','meeting_booked','trial_started','signup') or (e.kind in ('reply','positive_reply','not_now') and e.occurred_at>v_since)))))
 or (v_cold and exists(select 1 from private.growth_organizations where id=o.organization_id and tenant_id is not null))
 or not exists(select 1 from private.customer_success_plans where id=m.work_id and status='open') then
  update private.growth_messages set status='cancelled' where id=m.id; return jsonb_build_object('send',false,'status','cancelled');
 end if;
 -- A business is cold-emailed once: every cold email to it goes to the one contact, for the one opportunity, of its first touch.
 if v_cold and exists(select 1 from private.growth_messages x join private.growth_contacts xc on xc.id=x.contact_id
   where xc.organization_id=c.organization_id and private.growth_message_class('marketing_manager',x.purpose,xc.source_kind)='growth.cold_email' and x.attempted_at is not null
     and x.id<>m.id and (x.contact_id<>c.id or x.opportunity_id<>o.id)) then
  update private.growth_messages set status='cancelled' where id=m.id; return jsonb_build_object('send',false,'status','business_contacted');
 end if;
 if a.decided_by is null and coalesce((select e.passed from private.agent_evaluations e where e.product=o.product and e.version='growth.1' and e.created_at>now()-interval '30 days' order by e.created_at desc limit 1),false) is not true then return jsonb_build_object('send',false,'status','evaluation_required'); end if;
 if exists(select 1 from private.growth_messages where contact_id=c.id and id<>m.id and status in ('unknown','sending')) then return jsonb_build_object('send',false,'status','delivery_unresolved'); end if;
 if exists(select 1 from private.growth_messages where contact_id=c.id and attempted_at>now()-make_interval(hours=>(select max(min_gap_hours) from private.growth_policies))) then return jsonb_build_object('send',false,'status','frequency_limited'); end if;
 if exists(select 1 from private.agent_lifecycle_emails e where e.email_hash=private.email_hash(c.email) and e.created_at>now()-make_interval(hours=>(select max(min_gap_hours) from private.growth_policies))) then return jsonb_build_object('send',false,'status','frequency_limited'); end if;
 select count(*) into v_n from private.growth_messages where opportunity_id=o.id and purpose='marketing' and attempted_at is not null and attempted_at>v_since;
 if m.purpose='marketing' and v_n>=(case when v_since>'-infinity'::timestamptz then 1 else p.max_touches end) then return jsonb_build_object('send',false,'status','touch_limit'); end if;
 select count(*) into v_n from private.growth_messages x join private.growth_opportunities y on y.id=x.opportunity_id where y.product=o.product and x.attempted_at>=private.agent_day_start(); -- the Eastern day, like every other send cap
 if v_n>=p.daily_limit then return jsonb_build_object('send',false,'status','daily_limit'); end if;
 -- Cold email: a cap for the Eastern day across both products, however each was approved. Ten unless the owner has set
 -- Settings -> Customer growth -> "Most cold emails a day" (private.growth_cold_email_cap: 1 to 100, null when not set).
 if v_cold then
  select count(*) into v_cold_sent from private.growth_messages x join private.growth_contacts xc on xc.id=x.contact_id
  where private.growth_message_class('marketing_manager',x.purpose,xc.source_kind)='growth.cold_email' and x.attempted_at>=private.agent_day_start();
  v_cap:=private.growth_cold_email_cap();
  if v_cap is not null and v_cold_sent >= v_cap then return jsonb_build_object('send',false,'status','daily_limit'); end if;
  if v_cap is null and v_cold_sent >= 10 then return jsonb_build_object('send',false,'status','daily_limit'); end if;
 end if;
 update private.growth_messages set status='sending',attempted_at=now() where id=m.id;
 return jsonb_build_object('send',true,'to',c.email,'subject',m.subject,'body',m.body,'purpose',m.purpose,'product',o.product,'id',m.id,'workId',m.work_id,'unsubscribeHash',m.unsubscribe_hash,
   'contactName',nullif(c.name,''),'sourceKind',c.source_kind);
end; $function$;
