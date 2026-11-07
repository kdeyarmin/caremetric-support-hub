-- Second round of fixes from the November 7 feature review. Each statement replaces a function with the same signature,
-- so grants are kept.
--
-- 1. private.claim_email_batch checked suppressions only when a campaign was queued. Someone who unsubscribed through an
--    earlier email's link while a large campaign was still sending received it anyway. Each claim now checks again.
-- 2. private.agent_lifecycle_begin_send let an email nobody approved go out when the Account Manager was paused, and did not
--    hold the agent's row. It now requires the agent to be active and holds the row, like every other automatic send.
-- 3. private.growth_claim_message counted a product's daily send limit from UTC midnight, while the cold-email cap and every
--    other agent cap use the Eastern day (private.agent_day_start()). A product could send its limit before 7 or 8 PM Eastern
--    and its limit again after. It now uses the Eastern day.

CREATE OR REPLACE FUNCTION private.claim_email_batch(p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb;
begin
  if session_user <> 'hub_app_server' then raise exception 'Application server required.' using errcode = '42501'; end if;
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid batch size.' using errcode = '22023'; end if;
  -- An address can be unsubscribed (through an earlier email's link) while a large campaign is still sending. Each claim
  -- checks again: a suppressed recipient is cancelled and its address and token cleared, never handed to SendGrid.
  with candidates as (
    select r2.id, exists (select 1 from private.email_suppressions x where x.email_hash = r2.email_hash) as suppressed
    from private.email_recipients r2 join private.email_campaigns c on c.id = r2.campaign_id
    where r2.status = 'queued' and c.status = 'sending' order by c.queued_at, r2.id limit p_limit for update of r2 skip locked
  ), skipped as (
    update private.email_recipients r set status = 'cancelled', email = null, unsubscribe_token = null, finished_at = clock_timestamp()
    from candidates k where r.id = k.id and k.suppressed returning r.id
  ), claimed as (
    update private.email_recipients r set status = 'sending', claimed_at = clock_timestamp()
    from candidates k where r.id = k.id and not k.suppressed
    returning r.id, r.campaign_id, r.email, r.unsubscribe_token, r.applications
  ) select coalesce(jsonb_agg(jsonb_build_object('id', claimed.id, 'to', claimed.email, 'token', claimed.unsubscribe_token,
      'applications', claimed.applications, 'subject', c.subject, 'body', c.body)), '[]'::jsonb) into result
    from claimed join private.email_campaigns c on c.id = claimed.campaign_id;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION private.agent_lifecycle_begin_send(p_action_id uuid, p_execution integer, p_unsubscribe_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- Nobody approved it: the Account Manager must still be active and trusted with this template, now. The row is held (shared)
  -- until this transaction commits, as the offer, answer, content and growth gates do, so a pause either commits first (and the
  -- email is not sent) or waits until it is recorded.
  if v_action.decided_by is null then
    select * into v_agent from private.agents where key = v_action.agent_key for share;
    if v_agent.status is distinct from 'active' or v_agent.autonomy is distinct from 'act' or jsonb_typeof(v_agent.config -> 'auto_send_templates') is distinct from 'array'
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
$function$;

CREATE OR REPLACE FUNCTION private.growth_claim_message(p_id uuid, p_action uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 select count(*) into v_n from private.growth_messages x join private.growth_opportunities y on y.id=x.opportunity_id where y.product=o.product and x.attempted_at>=private.agent_day_start(); -- the Eastern day, like every other send cap
 if v_n>=p.daily_limit then return jsonb_build_object('send',false,'status','daily_limit'); end if;
 -- Cold email: at most ten a day (Eastern) across both products, however each was approved.
 if v_cold then
  select count(*) into v_cold_sent from private.growth_messages x join private.growth_contacts xc on xc.id=x.contact_id
  where xc.source_kind='role_address' and x.purpose='marketing' and x.attempted_at>=private.agent_day_start();
  if v_cold_sent >= 10 then return jsonb_build_object('send',false,'status','daily_limit'); end if;
 end if;
 update private.growth_messages set status='sending',attempted_at=now() where id=m.id;
 return jsonb_build_object('send',true,'to',c.email,'subject',m.subject,'body',m.body,'purpose',m.purpose,'product',o.product,'id',m.id,'workId',m.work_id,'unsubscribeHash',m.unsubscribe_hash);
end; $function$;
