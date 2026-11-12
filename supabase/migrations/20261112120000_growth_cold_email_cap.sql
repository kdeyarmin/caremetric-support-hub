-- The cold-email cap becomes a Hub setting (owner request 2026-11-12).
--
-- private.growth_claim_message has allowed at most ten cold emails an Eastern day across both products, as a number written into
-- the function, since the owner chose capped cold email (2026-11-04). With follow-up touches counted, ten a day reaches three or
-- four new businesses a day, and raising it meant a migration. So:
--
-- - a new setting, growth.cold_email_daily_cap ("Most cold emails a day" under Settings -> Customer growth), a whole number from
--   1 to 100. Not set, the cap stays ten: nothing changes until the owner saves a value;
-- - private.growth_cold_email_cap() reads it for the claim: the saved whole number, held to 1..100 whatever was stored, or null
--   when it is not set or is not a whole number. No role may execute it; only the claim, which runs as its owner, calls it;
-- - private.growth_claim_message is replaced with the same signature (grants are kept) and the same body as
--   20261107140000_review_round_two.sql, except that the cold-email cap is the setting when one is saved and ten otherwise.
--
-- Everything else about a send is unchanged: each product's own daily limit (the Growth screen), the gap between messages to a
-- contact, the touch cap, one cold contact per business, suppression, the daily guardrail check and the hand-over checks. A
-- product's own daily limit still applies beneath this cap, so raising the cap alone does not raise what one product sends.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.cold_email_daily_cap', 'number')
on conflict (key) do nothing;

create function private.growth_cold_email_cap() returns integer
language sql stable set search_path = '' as $$
  select case when jsonb_typeof(s.value) = 'number' and (s.value #>> '{}') ~ '^[0-9]{1,9}$'
    then least(greatest((s.value #>> '{}')::integer, 1), 100) end
  from private.hub_settings s where s.key = 'growth.cold_email_daily_cap';
$$;
revoke all on function private.growth_cold_email_cap() from public, anon, authenticated, service_role, hub_app_server;

CREATE OR REPLACE FUNCTION private.growth_claim_message(p_id uuid, p_action uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m private.growth_messages%rowtype; o private.growth_opportunities%rowtype; c private.growth_contacts%rowtype; p private.growth_policies%rowtype; a private.agent_actions%rowtype; g private.agents%rowtype; v_n integer;
 v_class text; v_cold boolean; v_cold_sent integer; v_cap integer;
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

-- The gate: the claim reads the setting, keeps ten as the cap when none is saved, and the reader is closed to every role.
do $$ declare definition text := pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure); begin
  if position('v_cap:=private.growth_cold_email_cap();' in definition) = 0
    or position('v_cap is not null and v_cold_sent >= v_cap then' in definition) = 0
    or position('v_cap is null and v_cold_sent >= 10 then' in definition) = 0 then
    raise exception 'The cold-email cap must be the owner''s setting, or ten when none is saved' using errcode = '55000';
  end if;
  if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
             where has_function_privilege(r, 'private.growth_cold_email_cap()', 'execute')) then
    raise exception 'The cold-email cap reader must be closed to every role' using errcode = '55000';
  end if;
  if not has_function_privilege('hub_app_server', 'private.growth_claim_message(uuid,uuid)', 'execute')
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r
               where has_function_privilege(r, 'private.growth_claim_message(uuid,uuid)', 'execute')) then
    raise exception 'Only the Hub server may claim a growth message' using errcode = '55000';
  end if;
end $$;
