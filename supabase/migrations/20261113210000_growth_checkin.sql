-- Ask again, once, months later (review 2026-11-12, finding P1: no follow-up after a reply or after touch 3; nurture is a dead end).
--
-- A prospect who said "not now" moved to nurture and was never written to again: the send claim refused every marketing email to a
-- business that had replied, and to any opportunity in nurture. A prospect who never answered the policy's touches stayed in
-- "contacted" with nothing left to send. "Not now" was never asked again.
--
-- Now:
--
-- - private.growth_checkin_due(opportunity) says whether one check-in email is due, and why ('not_now' or 'no_reply'), or null:
--   - 'not_now': the opportunity is in nurture, the business's latest reply of any kind was "not now", at least 90 days ago, nothing
--     was emailed to anyone there for 90 days, and no check-in has gone to it since that reply. A refusal ("no thank you"), a
--     question, a trial or a cancellation as the latest reply is never asked again;
--   - 'no_reply': the opportunity is still "contacted" after every touch the product policy allows, the business never replied,
--     the last email to it was at least 90 days ago and no check-in was ever sent to this opportunity;
--   - only for opportunities the Marketing Manager owns. It is stable, no role may execute it, and the snapshot and the claim,
--     which run as its owner, call it;
-- - private.growth_snapshot is replaced with the same signature and body, adding checkin_due and last_reply_at to each item, so the
--   planner (server/growth/policy.mjs) plans one "checkin" work item when one is due;
-- - private.growth_claim_message is replaced with the same signature (grants are kept) and the same body as
--   20261112120000_growth_cold_email_cap.sql, except for a check-in, a marketing message whose work is of kind "checkin": it may go
--   to an opportunity in nurture or to a business that replied, past the touch limit, and without a fresh cited source, only while
--   private.growth_checkin_due still finds it due. Everything else applies to it as to any marketing email: the agent's trust and
--   class (cold email to a role address still needs the cold-email step and counts against the cold-email cap), a permitted and
--   verified contact, no suppression, no customer or internal organization, the gap between messages, delivery checks and the
--   daily limits.
--
-- - private.growth_contact_candidates is replaced with the same signature and grants: besides businesses with no contact, it now
--   offers the contact finder a business whose check-in is due but whose finder contact (a public role address) was last seen on its
--   site more than 80 days ago, at most once a week, so finding the same address again re-verifies it and the check-in can pass the
--   claim's 90-day rule. The worker drafts no check-in until then.
--
-- No table, grant, setting or declared feature changes.
set local lock_timeout = '10s';

create function private.growth_checkin_due(p_opportunity uuid) returns text
language sql stable set search_path = '' as $$
  select case
    when o.owner_agent <> 'marketing_manager' then null
    when o.stage = 'nurture' and r.kind = 'not_now' and r.occurred_at <= now() - interval '90 days'
      and coalesce(t.org_last, '-infinity') <= now() - interval '90 days'
      and not exists (select 1 from private.growth_messages m join private.customer_success_plans w on w.id = m.work_id
                      join private.growth_contacts c on c.id = m.contact_id
                      where c.organization_id = o.organization_id and w.kind = 'checkin' and m.attempted_at >= r.occurred_at)
      then 'not_now'
    when o.stage = 'contacted' and r.kind is null and t.touches >= coalesce(p.max_touches, 3)
      and t.org_last <= now() - interval '90 days'
      and not exists (select 1 from private.growth_messages m join private.customer_success_plans w on w.id = m.work_id
                      where m.opportunity_id = o.id and w.kind = 'checkin' and m.attempted_at is not null)
      then 'no_reply'
  end
  from private.growth_opportunities o
  left join private.growth_policies p on p.product = o.product
  left join lateral (
    select e.kind, e.occurred_at from private.customer_activity_events e
    where e.organization_id = o.organization_id
      and e.kind in ('reply', 'positive_reply', 'negative_reply', 'not_now', 'meeting_booked', 'trial_started', 'cancel_requested')
    order by e.occurred_at desc limit 1) r on true
  cross join lateral (
    select (select count(*) from private.growth_messages m where m.opportunity_id = o.id and m.purpose = 'marketing' and m.attempted_at is not null) as touches,
           (select max(m.attempted_at) from private.growth_messages m join private.growth_contacts c on c.id = m.contact_id
            where c.organization_id = o.organization_id and m.purpose = 'marketing') as org_last) t
  where o.id = p_opportunity;
$$;
revoke all on function private.growth_checkin_due(uuid) from public, anon, authenticated, service_role, hub_app_server;

create or replace function private.growth_snapshot(p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$ begin
 perform private.require_hub_app_server();
 if p_offset is null or p_offset<0 then raise exception 'Invalid offset' using errcode='22023'; end if;
 return jsonb_build_object('total',(select count(*) from private.growth_opportunities),'items',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (
 select o.*,g.name,g.domain,g.internal,g.tenant_id,c.name as contact_name,c.eligibility,c.verified_at,c.version as contact_version,
 (select to_jsonb(p) from private.growth_policies p where p.product=o.product) as policy,
 (select coalesce(jsonb_agg(to_jsonb(e)),'[]') from (select id,source_url,claim,confidence,observed_at from private.growth_evidence where opportunity_id=o.id order by observed_at desc limit 20) e) as evidence,
 (select coalesce(jsonb_agg(to_jsonb(e)),'[]') from (select kind,occurred_at,facts from private.customer_activity_events where organization_id=o.organization_id and product=o.product and occurred_at>now()-interval '90 days' order by occurred_at desc limit 500) e) as events,
 (select coalesce(jsonb_agg(to_jsonb(w)),'[]') from (select w.*,m.id as message_id,m.status as message_status,m.withdrawn_at is not null as message_withdrawn,m.opportunity_version as message_opportunity_version,m.contact_version as message_contact_version,m.policy_version as message_policy_version from private.customer_success_plans w left join lateral(select m1.* from private.growth_messages m1 where m1.work_id=w.id order by m1.created_at desc limit 1) m on true where w.opportunity_id=o.id) w) as work,
 (select count(*) from private.growth_messages m where m.opportunity_id=o.id and m.purpose='marketing' and m.attempted_at is not null) as touches,
 (select max(m.attempted_at) from private.growth_messages m where m.contact_id=o.contact_id) as last_touch,
 private.growth_checkin_due(o.id) as checkin_due,
 (select max(e.occurred_at) from private.customer_activity_events e where e.organization_id=o.organization_id and e.kind in ('reply','positive_reply','negative_reply','not_now','meeting_booked','trial_started','cancel_requested')) as last_reply_at
 from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id left join private.growth_contacts c on c.id=o.contact_id order by o.id limit 100 offset p_offset) x));
end; $$;

CREATE OR REPLACE FUNCTION private.growth_claim_message(p_id uuid, p_action uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m private.growth_messages%rowtype; o private.growth_opportunities%rowtype; c private.growth_contacts%rowtype; p private.growth_policies%rowtype; a private.agent_actions%rowtype; g private.agents%rowtype; v_n integer;
 v_class text; v_cold boolean; v_cold_sent integer; v_cap integer; v_checkin boolean;
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
 -- A check-in (private.growth_checkin_due): the one email asking again, months later, a prospect who said "not now" or never
 -- answered the touches. Only while the database still finds it due; the other marketing rules below make way for it.
 v_checkin:=m.purpose='marketing' and exists(select 1 from private.customer_success_plans w where w.id=m.work_id and w.kind='checkin');
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
 or (m.purpose='marketing' and not v_checkin and not exists(select 1 from private.growth_evidence e where e.opportunity_id=o.id and e.id::text in(select jsonb_array_elements_text(m.citations)) and e.observed_at between now()-interval '30 days' and now()))
 or o.stage in ('lost','churned','disqualified') or (o.stage='nurture' and not v_checkin)
 or (m.purpose='marketing' and not v_checkin and (o.stage not in ('qualified','contacted') or exists(select 1 from private.customer_activity_events e where e.organization_id=o.organization_id and e.kind in ('reply','positive_reply','negative_reply','not_now','meeting_booked','trial_started'))))
 or (v_checkin and private.growth_checkin_due(o.id) is null)
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
 if m.purpose='marketing' and not v_checkin and v_n>=p.max_touches then return jsonb_build_object('send',false,'status','touch_limit'); end if;
 select count(*) into v_n from private.growth_messages x join private.growth_opportunities y on y.id=x.opportunity_id where y.product=o.product and x.attempted_at>=private.agent_day_start(); -- the Eastern day, like every other send cap
 if v_n>=p.daily_limit then return jsonb_build_object('send',false,'status','daily_limit'); end if;
 -- Cold email: a cap for the Eastern day across both products, however each was approved. Ten unless the owner has set
 -- Settings -> Customer growth -> "Most cold emails a day" (private.growth_cold_email_cap: 1 to 100, null when not set).
 if v_cold then
  select count(*) into v_cold_sent from private.growth_messages x join private.growth_contacts xc on xc.id=x.contact_id
  where xc.source_kind='role_address' and x.purpose='marketing' and x.attempted_at>=private.agent_day_start();
  v_cap:=private.growth_cold_email_cap();
  if v_cap is not null and v_cold_sent >= v_cap then return jsonb_build_object('send',false,'status','daily_limit'); end if;
  if v_cap is null and v_cold_sent >= 10 then return jsonb_build_object('send',false,'status','daily_limit'); end if;
 end if;
 update private.growth_messages set status='sending',attempted_at=now() where id=m.id;
 return jsonb_build_object('send',true,'to',c.email,'subject',m.subject,'body',m.body,'purpose',m.purpose,'product',o.product,'id',m.id,'workId',m.work_id,'unsubscribeHash',m.unsubscribe_hash);
end; $function$;

-- The same as 20261105150000_growth_autonomy.sql, plus businesses whose check-in is due but whose finder contact was last seen on
-- their own site more than 80 days ago: the claim sends only to a contact verified in the last 90 days, and a check-in is due at
-- least 90 days after the last email, so the finder looks at the site again (at most once a week), and finding the same address
-- re-verifies it (private.growth_record_contact). New businesses with no contact still come first.
create or replace function private.growth_contact_candidates(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$ begin
 perform private.require_hub_app_server();
 if p_limit is null or p_limit<1 or p_limit>20 then raise exception 'Invalid page' using errcode='22023'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'domain',x.domain) order by x.reverify,x.discovered_at,x.id),'[]'::jsonb) from (
  select g.id,g.domain,g.discovered_at,not y.missing as reverify from private.growth_organizations g
  cross join lateral (select
    (g.contact_searched_at is null or g.contact_searched_at<now()-interval '90 days')
      and exists(select 1 from private.growth_opportunities o where o.organization_id=g.id and o.contact_id is null and o.stage in ('identified','researched','qualified')) as missing,
    (g.contact_searched_at is null or g.contact_searched_at<now()-interval '7 days')
      and exists(select 1 from private.growth_opportunities o join private.growth_contacts c on c.id=o.contact_id
                 where o.organization_id=g.id and c.source_kind='role_address' and (c.verified_at is null or c.verified_at<now()-interval '80 days')
                   and private.growth_checkin_due(o.id) is not null) as stale) y
  where g.discovered_at is not null and not g.internal and g.tenant_id is null and (y.missing or y.stale)
  order by not y.missing,g.discovered_at,g.id limit p_limit) x);
end; $$;

do $$
declare r text;
begin
  if not exists (select 1 from pg_proc where oid = 'private.growth_claim_message(uuid,uuid)'::regprocedure and prosecdef
                   and proconfig @> array['search_path=""'] and prosrc like '%require_hub_app_server%' and prosrc like '%growth_checkin_due(o.id) is null%'
                   and prosrc like '%growth.workflow%' and prosrc like '%frequency_limited%' and prosrc like '%agent_lifecycle_emails%')
     or not has_function_privilege('hub_app_server', 'private.growth_claim_message(uuid,uuid)', 'execute') then
    raise exception 'The claim does not know check-ins' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_proc where oid = 'private.growth_contact_candidates(integer)'::regprocedure and prosecdef
                   and proconfig @> array['search_path=""'] and prosrc like '%require_hub_app_server%' and prosrc like '%growth_checkin_due%')
     or not has_function_privilege('hub_app_server', 'private.growth_contact_candidates(integer)', 'execute')
     or has_function_privilege('authenticated', 'private.growth_contact_candidates(integer)', 'execute') then
    raise exception 'The contact finder does not re-verify contacts for check-ins' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_proc where oid = 'private.growth_snapshot(integer)'::regprocedure and prosecdef
                   and prosrc like '%require_hub_app_server%' and prosrc like '%checkin_due%')
     or not has_function_privilege('hub_app_server', 'private.growth_snapshot(integer)', 'execute') then
    raise exception 'The snapshot does not say when a check-in is due' using errcode = '55000';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_function_privilege(r, 'private.growth_checkin_due(uuid)', 'execute')
       or (r <> 'hub_app_server' and (has_function_privilege(r, 'private.growth_claim_message(uuid,uuid)', 'execute')
                                     or has_function_privilege(r, 'private.growth_snapshot(integer)', 'execute'))) then
      raise exception 'Growth check-ins exposed to %', r using errcode = '55000';
    end if;
  end loop;
end $$;
