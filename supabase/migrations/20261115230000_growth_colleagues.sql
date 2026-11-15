-- Cold outreach to several decision-makers at one agency (owner decision 2026-11-15): each outreach touch to an organization also goes
-- to up to N-1 other permitted decision-makers there (owner, administrator, business development or marketing leader, then other
-- managers), where N is Settings -> Customer growth -> "Most people to email at one organization" (1 to 5, three until the owner
-- saves a number; the primary contact counts).
--
-- The design, and why. A colleague's email is a row of private.growth_messages like any other (a "colleague row"), with
-- primary_message_id naming the touch's own message (the "primary row", to the opportunity's contact). It is created only after the
-- primary row was sent, as a copy of its approved subject, body, citations, arms and memo version (so the same draft, the same agency
-- report link, never a new model text), addressed to one person. Because it is an ordinary message row, every existing path applies
-- to it unchanged and per person: proposing (private.growth_propose: the cold-email trust decides exactly as for the primary, so it is
-- approved on its own only with growth.cold_email in the Marketing Manager's list, otherwise the owner approves it), the send claim
-- with every one of its checks (the person's eligibility, verification and suppression, the agent's trust re-checked with its row held,
-- the daily evaluation, the 72-hour gap per address, the shared customer-email gap, the product's daily limit and the owner's cold-email
-- cap, both of which count it), the unsubscribe link (its own hash), delivery events and their reconciliation (the provider's message id
-- is the row's id), the Growth history and the audit trail. Separate emails, never CC or BCC: each row is one email to one address.
--
-- The alternative, a table of its own for colleague deliveries, would have needed a second claim, a second unsubscribe and delivery
-- path, and every frequency check, cap and report taught to read two tables. One column changes less. What it does need:
--
-- 1. Touch counting does not multiply. A colleague row has no work item of its own (work_id is null: the touch's work is its primary
--    row's, and the work's draft key growth_messages_draft_key is untouched), it never counts as a touch (the snapshot, the claim's
--    touch limit, the re-ask and the learning counts read primary rows only), and its acceptance or failure does not move the
--    opportunity (private.growth_finish_message: its next touch is still due from the primary's, and its siblings' versions stay
--    current).
-- 2. Who: private.growth_colleague_pool. People at the same organization, other than the primary contact, permitted and verified within
--    90 days, not suppressed, with a name or a role, never a generic address (info@, office@ ...; a role address is only ever a primary
--    contact), and cold-email addresses only: a person the Hub found (enriched) or the owner imported. A person who wrote in, or whom the
--    owner typed in, is a sales follow-up and never rides a cold sequence. Best first by role (private.growth_colleague_rank: owner,
--    administrator, business development or marketing, then other managers and directors), at most N-1. Touch 1 chooses afresh; every
--    later touch (a re-ask included) goes only to the people who received the touch before it (accepted or delivered), so a sequence
--    never restarts for someone who joins later and a bounced colleague is dropped.
-- 3. When: private.growth_colleague_candidates lists, for each cold touch sent in the last 48 hours that is still its opportunity's
--    latest, the people still to write to; the Marketing Manager's fifteen-minute sweep records each (private.growth_colleague_draft,
--    with the unsubscribe hash the server signs for that touch and person) and proposes it. So colleagues get the same touch the same
--    day, a little after the primary.
-- 4. One sequence per organization: the claim refuses a colleague row unless its primary row was sent and is still the opportunity's
--    latest touch, the primary contact is still the opportunity's contact and still permitted, the person is still in the pool, and
--    fewer than N-1 colleagues got this touch. The once-per-business rule now reads primary rows for "one contact" and still refuses
--    any cold email for a second opportunity.
-- 5. Stop rules cover the whole organization. A reply from anyone there already stops it (private.growth_inquiry). An opt-out or a
--    complaint from anyone there, or a hard bounce of the primary contact, cancels every unsent outreach email to everyone at the
--    organization (private.growth_delivery_event), and an opt-out or complaint stops its cold outreach for good
--    (private.growth_outreach_stopped: the claim, the snapshot and the re-ask read it). A colleague whose address hard-bounces is opted
--    out and dropped, as before; the rest go on. A soft bounce opts nobody out (20261113280000) and does not stop the touch.
-- 6. The Growth screen shows who received each touch (hub.growth_detail: each touch with its recipients), and the approval preview of a
--    colleague row names the person it goes to.
--
-- Nothing is sent by this migration. 20261115230100_growth_colleagues_contract.sql declares platform.agents.growth-colleagues.v1, and
-- the server prepares colleague rows only once it is declared.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.people_per_organization', 'number')
on conflict (key) do nothing;

-- The owner's number of people per organization and touch, the primary contact included: the saved whole number held to 1..5, or 3.
create or replace function private.growth_people_per_organization() returns integer
language sql stable set search_path = '' as $$
  select coalesce((select case when jsonb_typeof(s.value) = 'number' and (s.value #>> '{}') ~ '^[0-9]{1,9}$'
    then least(greatest((s.value #>> '{}')::integer, 1), 5) end from private.hub_settings s where s.key = 'growth.people_per_organization'), 3);
$$;

alter table private.growth_messages add column if not exists primary_message_id uuid references private.growth_messages(id);
alter table private.growth_messages drop constraint if exists growth_messages_colleague_check;
alter table private.growth_messages add constraint growth_messages_colleague_check check (
  primary_message_id is null or (primary_message_id <> id and work_id is null and purpose = 'marketing'));
-- One colleague row per touch, person and context, as the draft key is for primary rows; a withdrawn one frees it.
create unique index if not exists growth_messages_colleague_key on private.growth_messages
  (primary_message_id, contact_id, opportunity_version, contact_version, policy_version) where primary_message_id is not null and withdrawn_at is null;
create index if not exists growth_delivery_events_stops on private.growth_delivery_events (message_id) where kind in ('complaint', 'unsubscribe');

-- A generic mailbox, never a person's: only ever a primary contact.
create or replace function private.growth_generic_address(p_email text) returns boolean
language sql immutable set search_path = '' as $$
  select split_part(lower(coalesce(p_email, '')), '@', 1) in (
    'info', 'contact', 'contactus', 'office', 'admin', 'administrator', 'hello', 'inquiries', 'inquiry', 'enquiries', 'enquiry',
    'sales', 'admissions', 'reception', 'frontdesk', 'general', 'mail', 'team', 'marketing', 'intake', 'referral', 'referrals',
    'billing', 'support', 'help', 'hr', 'jobs', 'careers', 'noreply', 'no-reply', 'donotreply', 'webmaster', 'postmaster',
    'accounts', 'accounting', 'scheduling', 'service', 'customerservice', 'care', 'staff', 'hospice', 'homecare', 'homehealth');
$$;

-- How much a role decides, lower first: owner, administrator, business development or marketing, then other managers and directors.
create or replace function private.growth_colleague_rank(p_role text) returns integer
language sql immutable set search_path = '' as $$
  select case
    when coalesce(p_role, '') ~* '\mvice president\M' then 4
    when coalesce(p_role, '') ~* '\m(owner|co-?owner|founder|co-?founder|ceo|chief executive|president|principal)\M' then 1
    when coalesce(p_role, '') ~* '\m(administrator|executive director)\M' then 2
    when coalesce(p_role, '') ~* '\m(business development|marketing|community liaison|community relations|community outreach)\M' then 3
    when coalesce(p_role, '') ~* '\m(manager|director|chief|vp|supervisor|coordinator)\M' then 4
    else 5 end;
$$;

-- Whether an organization asked growth email to stop: an opt-out or a complaint from anyone there, on any outreach email, or a
-- request to stop written in an email to us. growth_inquiry reads one in a reply and opts the sender out without a delivery event,
-- so someone there who is opted out and has written to us counts too. A hard bounce alone opts a person out without them writing,
-- and never stops the organization.
create or replace function private.growth_outreach_stopped(p_org uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from private.growth_delivery_events d join private.growth_messages x on x.id = d.message_id
    join private.growth_opportunities y on y.id = x.opportunity_id
    where y.organization_id = p_org and x.purpose = 'marketing' and d.kind in ('complaint', 'unsubscribe'))
  or exists (select 1 from private.growth_contacts c where c.organization_id = p_org and c.eligibility = 'opted_out'
    and exists (select 1 from private.communications m where m.channel = 'email' and lower(btrim(m.contact_email)) = c.email));
$$;
create index if not exists communications_contact_email on private.communications (lower(btrim(contact_email))) where channel = 'email';

-- Why a sent touch may not (or not yet) go to colleagues, or null when it may. 'unresolved': its own delivery is still unknown.
create or replace function private.growth_colleague_primary(p_primary uuid) returns text
language plpgsql stable set search_path = '' as $$
declare pm private.growth_messages%rowtype; o private.growth_opportunities%rowtype; pc private.growth_contacts%rowtype;
 g private.growth_organizations%rowtype; v_since timestamptz;
begin
 select * into pm from private.growth_messages where id = p_primary;
 if not found or pm.primary_message_id is not null or pm.purpose <> 'marketing' or pm.attempted_at is null then return 'not_a_touch'; end if;
 if pm.status in ('sending', 'unknown') then return 'unresolved'; end if;
 -- A soft bounce opts nobody out and does not stop the touch; a hard bounce opts the primary contact out (below).
 if pm.status not in ('accepted', 'delivered', 'bounced') then return 'not_sent'; end if;
 select * into o from private.growth_opportunities where id = pm.opportunity_id;
 select * into pc from private.growth_contacts where id = pm.contact_id;
 select * into g from private.growth_organizations where id = o.organization_id;
 if o.owner_agent <> 'marketing_manager' or o.contact_id is distinct from pm.contact_id or o.stage not in ('qualified', 'contacted') then return 'opportunity_changed'; end if;
 if g.internal or g.tenant_id is not null then return 'customer'; end if;
 if private.growth_message_class('marketing_manager', pm.purpose, pc.source_kind) is distinct from 'growth.cold_email'
   or not exists (select 1 from private.agent_actions a where a.id = pm.action_id and a.agent_key = 'marketing_manager') then return 'not_cold'; end if;
 if pc.eligibility <> 'permitted' or exists (select 1 from private.email_suppressions s where s.email_hash = encode(extensions.digest(pc.email, 'sha256'), 'hex')) then
  return 'primary_stopped';
 end if;
 if private.growth_outreach_stopped(o.organization_id) then return 'stopped'; end if;
 v_since := case when o.memory ? 'reengagedAt' and (o.memory ->> 'reengagedAt') ~ '^\d{4}-' then (o.memory ->> 'reengagedAt')::timestamptz else '-infinity'::timestamptz end;
 if exists (select 1 from private.customer_activity_events e where e.organization_id = o.organization_id
     and (e.kind in ('negative_reply', 'meeting_booked', 'trial_started', 'signup') or (e.kind in ('reply', 'positive_reply', 'not_now') and e.occurred_at > v_since))) then
  return 'replied';
 end if;
 if exists (select 1 from private.growth_messages x where x.opportunity_id = o.id and x.primary_message_id is null and x.purpose = 'marketing'
     and x.attempted_at > pm.attempted_at) then
  return 'superseded';
 end if;
 return null;
end; $$;

-- The people a sent touch goes to besides its primary contact, best first, at most the owner's number less one. Touch 1 chooses
-- afresh; a later touch goes only to those who received the touch before it.
create or replace function private.growth_colleague_pool(p_primary uuid) returns table(contact_id uuid)
language plpgsql stable set search_path = '' as $$
#variable_conflict use_column
declare pm private.growth_messages%rowtype; v_org uuid; v_prev uuid;
begin
 select * into pm from private.growth_messages where id = p_primary;
 if not found or pm.primary_message_id is not null or pm.attempted_at is null then return; end if;
 select organization_id into v_org from private.growth_opportunities where id = pm.opportunity_id;
 select x.id into v_prev from private.growth_messages x where x.opportunity_id = pm.opportunity_id and x.primary_message_id is null
   and x.purpose = 'marketing' and x.attempted_at is not null and x.attempted_at < pm.attempted_at order by x.attempted_at desc, x.id desc limit 1;
 return query
  select c.id from private.growth_contacts c
  where c.organization_id = v_org and c.id <> pm.contact_id
    and c.source_kind in ('enriched', 'imported') and c.eligibility = 'permitted' and c.verified_at > now() - interval '90 days'
    and (btrim(c.name) <> '' or btrim(c.role) <> '') and not private.growth_generic_address(c.email)
    and not exists (select 1 from private.email_suppressions s where s.email_hash = encode(extensions.digest(c.email, 'sha256'), 'hex'))
    and (v_prev is null or exists (select 1 from private.growth_messages r where r.primary_message_id = v_prev and r.contact_id = c.id
                                     and r.status in ('accepted', 'delivered')))
  order by private.growth_colleague_rank(c.role), c.verified_at desc, c.created_at, c.id
  limit greatest(private.growth_people_per_organization() - 1, 0);
end; $$;

revoke all on function private.growth_people_per_organization(), private.growth_generic_address(text), private.growth_colleague_rank(text),
  private.growth_outreach_stopped(uuid), private.growth_colleague_primary(uuid), private.growth_colleague_pool(uuid)
  from public, anon, authenticated, service_role, hub_app_server;

-- Server (the Marketing Manager's sweep): the people still to write to for the cold touches sent in the last 48 hours. A person with a
-- colleague row for the touch that was sent, waits for the owner, or was cancelled under today's context is not listed again; a row
-- recorded but not yet proposed is, so the sweep proposes it.
create or replace function private.growth_colleague_candidates(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 if p_limit is null or p_limit < 1 or p_limit > 100 then raise exception 'Invalid page' using errcode = '22023'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('primaryId', x.primary_id, 'workId', x.work_id, 'contactId', x.contact_id, 'product', x.product)
   order by x.attempted_at, x.primary_id, x.contact_id), '[]'::jsonb) from (
  select pm.id as primary_id, pm.work_id, pool.contact_id, o.product, pm.attempted_at
  from private.growth_messages pm
  join private.growth_opportunities o on o.id = pm.opportunity_id
  join private.growth_policies p on p.product = o.product
  cross join lateral private.growth_colleague_pool(pm.id) pool
  join private.growth_contacts c on c.id = pool.contact_id
  where pm.primary_message_id is null and pm.purpose = 'marketing' and pm.attempted_at > now() - interval '48 hours'
    and pm.status in ('accepted', 'delivered', 'bounced') and p.enabled and private.growth_colleague_primary(pm.id) is null
    and not exists (select 1 from private.growth_messages r where r.primary_message_id = pm.id and r.contact_id = pool.contact_id and r.withdrawn_at is null
      and (r.attempted_at is not null or r.status in ('proposed', 'sending')
        or (r.status <> 'draft' and r.opportunity_version = o.version and r.contact_version = c.version and r.policy_version = p.version)))
  order by pm.attempted_at, pm.id, pool.contact_id
  limit p_limit) x);
end; $$;

-- Server: one colleague row for a sent touch and one person in its pool, a copy of the touch's approved subject and body under today's
-- context, with the unsubscribe hash the server signed for that touch and person. Returns the row (an existing one for the same touch,
-- person and context), or why none is recorded. Nothing is sent here; the sweep proposes it.
create or replace function private.growth_colleague_draft(p_primary uuid, p_contact uuid, p_unsubscribe_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pm private.growth_messages%rowtype; o private.growth_opportunities%rowtype; c private.growth_contacts%rowtype; p private.growth_policies%rowtype;
 v_reason text; v_id uuid; v_created boolean := false;
begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_unsubscribe_hash is null or p_unsubscribe_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid unsubscribe hash' using errcode = '22023'; end if;
 select * into pm from private.growth_messages where id = p_primary for update;
 if not found then raise exception 'Unknown message' using errcode = '22023'; end if;
 v_reason := private.growth_colleague_primary(p_primary);
 if v_reason is not null then return jsonb_build_object('created', false, 'reason', v_reason); end if;
 if not exists (select 1 from private.growth_colleague_pool(p_primary) x where x.contact_id = p_contact) then
  return jsonb_build_object('created', false, 'reason', 'not_chosen');
 end if;
 select * into o from private.growth_opportunities where id = pm.opportunity_id;
 select * into c from private.growth_contacts where id = p_contact;
 select * into p from private.growth_policies where product = o.product;
 insert into private.growth_messages(opportunity_id, work_id, contact_id, purpose, subject, body, citations, opportunity_version, contact_version,
   policy_version, unsubscribe_hash, variant, model_generated, arms, memo_version, primary_message_id)
 values (pm.opportunity_id, null, c.id, 'marketing', pm.subject, pm.body, pm.citations, o.version, c.version, p.version, p_unsubscribe_hash,
   pm.variant, pm.model_generated, pm.arms, pm.memo_version, pm.id)
 on conflict (primary_message_id, contact_id, opportunity_version, contact_version, policy_version) where primary_message_id is not null and withdrawn_at is null
 do nothing returning id into v_id;
 if v_id is null then
  select id into v_id from private.growth_messages where primary_message_id = pm.id and contact_id = c.id and opportunity_version = o.version
    and contact_version = c.version and policy_version = p.version and withdrawn_at is null;
 else
  v_created := true;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (null, 'growth.colleague_added', 'growth_message', v_id, jsonb_build_object('touch', pm.id, 'contact', c.id, 'rank', private.growth_colleague_rank(c.role)));
 end if;
 return (select jsonb_build_object('created', v_created, 'id', id, 'status', status, 'actionId', action_id) from private.growth_messages where id = v_id);
end; $$;

revoke all on function private.growth_colleague_candidates(integer), private.growth_colleague_draft(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function private.growth_colleague_candidates(integer), private.growth_colleague_draft(uuid, uuid, text) to hub_app_server;

-- The same as 20261105150000_growth_autonomy.sql, except that a colleague row's approval preview names the person it goes to.
create or replace function private.growth_propose(p_task uuid,p_message uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m private.growth_messages%rowtype; a jsonb; v_agent private.agents%rowtype; v_class text; v_trusted boolean; v_to text:=''; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0)); select * into m from private.growth_messages where id=p_message for update;
 if m.status not in ('draft','proposed') then return null; end if;
 if m.action_id is not null then return jsonb_build_object('id',m.action_id); end if;
 -- A colleague row is the touch's approved email again, to one more person at the business: the preview says to whom.
 if m.primary_message_id is not null then
  select 'Also to '||coalesce(nullif(btrim(c.name),''),c.email)||coalesce(' ('||nullif(btrim(c.role),'')||')','')||' <'||c.email||'>, the same email the business''s first contact received.'||E'\n\n'
   into v_to from private.growth_contacts c where c.id=m.contact_id;
 end if;
 a:=private.agent_action_propose(p_task,null,'growth.message','growth_message',m.id::text,coalesce(v_to,'')||m.subject||E'\n\n'||m.body,
   jsonb_build_object('messageId',m.id)||case when m.primary_message_id is not null then jsonb_build_object('colleagueOf',m.primary_message_id) else '{}'::jsonb end);
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

-- The same as 20261113172000_growth_reengage.sql, except for colleague rows (marked "colleague" below): a colleague row needs its touch
-- sent, still current and with room for one more person, and its person still chosen; it is not a touch of its own; one business is
-- still one contact and one opportunity for its primary rows; and an organization that opted out or complained gets no cold email.
CREATE OR REPLACE FUNCTION private.growth_claim_message(p_id uuid, p_action uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m private.growth_messages%rowtype; o private.growth_opportunities%rowtype; c private.growth_contacts%rowtype; p private.growth_policies%rowtype; a private.agent_actions%rowtype; g private.agents%rowtype; v_n integer;
 v_class text; v_cold boolean; v_cold_sent integer; v_cap integer; v_since timestamptz; v_work uuid; v_ready text;
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
 -- colleague: a colleague row is the work of its touch's primary row.
 v_work:=coalesce(m.work_id,(select x.work_id from private.growth_messages x where x.id=m.primary_message_id));
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
 -- An opt-out or a complaint from anyone at the organization stops its cold outreach (20261115230000).
 or (v_cold and private.growth_outreach_stopped(o.organization_id))
 or not exists(select 1 from private.customer_success_plans where id=v_work and status='open') then
  update private.growth_messages set status='cancelled' where id=m.id; return jsonb_build_object('send',false,'status','cancelled');
 end if;
 -- colleague: cold email only, after its touch was sent and while that touch is the opportunity's latest, its primary contact still the
 -- opportunity's and permitted, the person still chosen, and fewer than the owner's number less one colleagues reached.
 if m.primary_message_id is not null then
  v_ready:=private.growth_colleague_primary(m.primary_message_id);
  if v_ready='unresolved' then return jsonb_build_object('send',false,'status','delivery_unresolved'); end if;
  if not v_cold or v_ready is not null
   or not exists(select 1 from private.growth_colleague_pool(m.primary_message_id) x where x.contact_id=c.id)
   or exists(select 1 from private.growth_messages x where x.primary_message_id=m.primary_message_id and x.contact_id=c.id and x.id<>m.id and x.attempted_at is not null)
   or (select count(*) from private.growth_messages x where x.primary_message_id=m.primary_message_id and x.id<>m.id and x.attempted_at is not null)
      >=private.growth_people_per_organization()-1 then
   update private.growth_messages set status='cancelled' where id=m.id; return jsonb_build_object('send',false,'status','cancelled');
  end if;
 end if;
 -- A business is cold-emailed once: every cold email to it is for the one opportunity of its first touch, and every primary row goes
 -- to the one contact of that touch (its colleagues ride the same touches).
 if v_cold and exists(select 1 from private.growth_messages x join private.growth_contacts xc on xc.id=x.contact_id
   where xc.organization_id=c.organization_id and private.growth_message_class('marketing_manager',x.purpose,xc.source_kind)='growth.cold_email' and x.attempted_at is not null
     and x.id<>m.id and (x.opportunity_id<>o.id or (x.contact_id<>c.id and x.primary_message_id is null and m.primary_message_id is null))) then
  update private.growth_messages set status='cancelled' where id=m.id; return jsonb_build_object('send',false,'status','business_contacted');
 end if;
 if a.decided_by is null and coalesce((select e.passed from private.agent_evaluations e where e.product=o.product and e.version='growth.1' and e.created_at>now()-interval '30 days' order by e.created_at desc limit 1),false) is not true then return jsonb_build_object('send',false,'status','evaluation_required'); end if;
 if exists(select 1 from private.growth_messages where contact_id=c.id and id<>m.id and status in ('unknown','sending')) then return jsonb_build_object('send',false,'status','delivery_unresolved'); end if;
 if exists(select 1 from private.growth_messages where contact_id=c.id and attempted_at>now()-make_interval(hours=>(select max(min_gap_hours) from private.growth_policies))) then return jsonb_build_object('send',false,'status','frequency_limited'); end if;
 if exists(select 1 from private.agent_lifecycle_emails e where e.email_hash=private.email_hash(c.email) and e.created_at>now()-make_interval(hours=>(select max(min_gap_hours) from private.growth_policies))) then return jsonb_build_object('send',false,'status','frequency_limited'); end if;
 -- Touches are the opportunity's primary rows: a colleague row rides a touch already counted.
 select count(*) into v_n from private.growth_messages where opportunity_id=o.id and purpose='marketing' and attempted_at is not null and attempted_at>v_since and primary_message_id is null;
 if m.purpose='marketing' and m.primary_message_id is null and v_n>=(case when v_since>'-infinity'::timestamptz then 1 else p.max_touches end) then return jsonb_build_object('send',false,'status','touch_limit'); end if;
 select count(*) into v_n from private.growth_messages x join private.growth_opportunities y on y.id=x.opportunity_id where y.product=o.product and x.attempted_at>=private.agent_day_start(); -- the Eastern day, like every other send cap
 if v_n>=p.daily_limit then return jsonb_build_object('send',false,'status','daily_limit'); end if;
 -- Cold email: a cap for the Eastern day across both products, however each was approved, colleagues' emails included. Ten unless the
 -- owner has set Settings -> Customer growth -> "Most cold emails a day" (private.growth_cold_email_cap: 1 to 100, null when not set).
 if v_cold then
  select count(*) into v_cold_sent from private.growth_messages x join private.growth_contacts xc on xc.id=x.contact_id
  where private.growth_message_class('marketing_manager',x.purpose,xc.source_kind)='growth.cold_email' and x.attempted_at>=private.agent_day_start();
  v_cap:=private.growth_cold_email_cap();
  if v_cap is not null and v_cold_sent >= v_cap then return jsonb_build_object('send',false,'status','daily_limit'); end if;
  if v_cap is null and v_cold_sent >= 10 then return jsonb_build_object('send',false,'status','daily_limit'); end if;
 end if;
 update private.growth_messages set status='sending',attempted_at=now() where id=m.id;
 -- colleague: its own opt-out link is signed for its touch's work and its person (server/growth/worker.mjs).
 return jsonb_build_object('send',true,'to',c.email,'subject',m.subject,'body',m.body,'purpose',m.purpose,'product',o.product,'id',m.id,'workId',v_work,'unsubscribeHash',m.unsubscribe_hash,
   'contactName',nullif(c.name,''),'sourceKind',c.source_kind,'colleague',m.primary_message_id is not null,
   'unsubscribeKey',case when m.primary_message_id is null then v_work::text else v_work::text||':'||c.id::text end);
end; $function$;

-- The same as 20261103150101_customer_growth.sql, except that a colleague row's acceptance or failure leaves the opportunity as its
-- touch left it: its next touch stays due from the primary's, and its sibling colleague rows keep their context.
create or replace function private.growth_finish_message(p_id uuid,p_status text,p_provider text) returns boolean
language plpgsql security definer set search_path='' as $$ begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 if p_status not in ('accepted','failed','unknown') then raise exception 'Invalid delivery' using errcode='22023'; end if;
 update private.growth_messages set status=case when status='sending' then p_status else status end,provider_id=p_provider where id=p_id and status in ('sending','delivered') and attempted_at is not null;
 if not found then return false; end if;
 update private.growth_opportunities o set stage=case when p_status='accepted' and o.stage='qualified' then 'contacted' else o.stage end,
 next_action=case when p_status='accepted' then 'Check reply and agreed next step' else 'Review unconfirmed or refused delivery' end,
 next_at=now()+case when p_status='accepted' then interval '4 days' else interval '1 hour' end,version=version+1,updated_at=now()
 from private.growth_messages m where m.id=p_id and o.id=m.opportunity_id and o.version=m.opportunity_version and m.primary_message_id is null;
 return true;
end; $$;

-- The same as 20261113280000_growth_soft_bounce_reporting.sql, except that the stop covers the organization: an opt-out or a complaint
-- from anyone there on an outreach email, or a hard bounce of a touch's primary contact, cancels every unsent outreach email to
-- everyone at the organization. A colleague's hard bounce opts that person out and cancels only theirs, as before.
create or replace function private.growth_delivery_event(p_event text,p_message uuid,p_kind text,p_at timestamptz,p_suppress boolean) returns boolean
language plpgsql security definer set search_path='' as $$ declare v_contact uuid; v_purpose text; v_primary uuid; v_org uuid; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 insert into private.growth_delivery_events(event_id,message_id,kind,occurred_at) values(p_event,p_message,p_kind,p_at) on conflict do nothing;
 if not found then return false; end if;
 if p_kind in ('complaint','unsubscribe') or (p_kind='bounced' and coalesce(p_suppress,true)) then
  select x.contact_id,x.purpose,x.primary_message_id,y.organization_id into v_contact,v_purpose,v_primary,v_org
   from private.growth_messages x join private.growth_opportunities y on y.id=x.opportunity_id where x.id=p_message;
  update private.growth_contacts set eligibility='opted_out',version=version+1 where id=v_contact;
  insert into private.email_suppressions(email_hash) select encode(extensions.digest(email,'sha256'),'hex') from private.growth_contacts where id=v_contact on conflict do nothing;
  update private.growth_messages set status='cancelled' where contact_id=v_contact and status in ('draft','proposed');
  if v_purpose='marketing' and (p_kind<>'bounced' or v_primary is null) then
   update private.growth_messages x set status='cancelled' from private.growth_opportunities y
    where y.id=x.opportunity_id and y.organization_id=v_org and x.purpose='marketing' and x.status in ('draft','proposed');
  end if;
 end if;
 update private.growth_messages set status=case when p_kind='unsubscribe' then 'cancelled' else p_kind end,delivered_at=case when p_kind='delivered' then p_at else delivered_at end where id=p_message
 and (p_kind<>'delivered' or status in ('accepted','unknown','sending','delivered'));
 return true;
end; $$;

-- The same as 20261111032204_growth_app_lifecycle.sql's growth_maintenance_before_lifecycle (from 20261113200000), except that a
-- colleague row's work is its touch's.
create or replace function private.growth_maintenance_before_lifecycle() returns integer
language plpgsql security definer set search_path='' as $$ declare n integer; v_actions uuid[]; v_tasks uuid[]; v_task uuid; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 update private.growth_messages set status='unknown' where status='sending' and attempted_at<now()-interval '10 minutes'; get diagnostics n=row_count;
 -- Reconcile before the worker reads its snapshot. Cancel only unsent drafts; never repeat an accepted or uncertain send.
 update private.growth_messages m set status='cancelled'
 from private.growth_opportunities o,private.growth_contacts c,private.growth_policies p
 where m.opportunity_id=o.id and m.contact_id=c.id and p.product=o.product and m.status in ('draft','proposed')
 and (m.opportunity_version<>o.version or m.contact_version<>c.version or m.policy_version<>p.version
   or not exists(select 1 from private.customer_success_plans w where w.id=coalesce(m.work_id,(select x.work_id from private.growth_messages x where x.id=m.primary_message_id)) and w.status='open'));
 -- A proposal nobody decided in time expires: its message is withdrawn, so the next sweep drafts a fresh one for the same work.
 -- A proposal the owner rejected is left as it is, final while nothing about the opportunity, contact or policy changes.
 update private.growth_messages m set status='cancelled',withdrawn_at=now()
 from private.agent_actions a where m.action_id=a.id and m.status='proposed' and a.status='expired';
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

-- The same as 20261105160000_growth_snapshot_redraft.sql, except that touches are the opportunity's primary rows and the sweep is told
-- when the organization stopped its cold outreach (no outreach is planned or drafted for it).
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
 (select count(*) from private.growth_messages m where m.opportunity_id=o.id and m.purpose='marketing' and m.attempted_at is not null and m.primary_message_id is null) as touches,
 (select max(m.attempted_at) from private.growth_messages m where m.contact_id=o.contact_id) as last_touch,
 coalesce(private.growth_message_class('marketing_manager','marketing',c.source_kind)='growth.cold_email' and private.growth_outreach_stopped(o.organization_id),false) as outreach_stopped
 from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id left join private.growth_contacts c on c.id=o.contact_id order by o.id limit 100 offset p_offset) x));
end; $$;

-- The same as 20261113270000_growth_reask_ready.sql, except that touches are the opportunity's primary rows and an organization that
-- opted out or complained is never asked again.
create or replace function private.growth_reengage(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_days integer := private.growth_recontact_days(); v_n integer; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_limit is null or p_limit < 1 or p_limit > 200 then raise exception 'Invalid page' using errcode = '22023'; end if;
 with facts as (
   select o.id, o.organization_id, o.stage,
     (select max(m.attempted_at) from private.growth_messages m where m.opportunity_id = o.id and m.purpose = 'marketing' and m.attempted_at is not null and m.primary_message_id is null) as last_touch,
     (select count(*) from private.growth_messages m where m.opportunity_id = o.id and m.purpose = 'marketing' and m.attempted_at is not null and m.primary_message_id is null) as touches,
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
     -- An address that can be current when the re-ask is sent: a public role address the contact finder can see again on the
     -- business's own site, or any other address verified in the last 80 days (a person's address is never re-read from a website).
     and (c.source_kind = 'role_address' or c.verified_at >= now() - interval '80 days')
     and not exists (select 1 from private.email_suppressions s where s.email_hash = encode(extensions.digest(c.email, 'sha256'), 'hex'))
     and not exists (select 1 from private.customer_activity_events e where e.organization_id = o.organization_id
       and e.kind in ('negative_reply', 'cancel_requested', 'trial_started', 'signup', 'paid', 'meeting_booked'))
     -- Anyone at the organization opted out or complained (20261115230000).
     and not private.growth_outreach_stopped(o.organization_id)),
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

-- The same as 20261113200000_growth_learning.sql, except that the counts are touches (primary rows): a touch is one experiment, however
-- many people at the business received it, and the owner's decisions on colleague rows say nothing about a draft.
create or replace function private.growth_learning_facts(p_product text, p_days integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 if p_product not in ('carebase', 'caremetric-intel') or p_days is null or p_days < 7 or p_days > 365 then raise exception 'Invalid window' using errcode = '22023'; end if;
 return (with sent as (
   select m.id, m.arms, m.memo_version, m.attempted_at, o.organization_id, m.status
   from private.growth_messages m join private.growth_opportunities o on o.id = m.opportunity_id
   where o.product = p_product and m.purpose = 'marketing' and m.attempted_at is not null and m.attempted_at >= now() - make_interval(days => p_days)
     and m.primary_message_id is null),
 outcome as (
   select s.*,
     (select e.kind from private.customer_activity_events e where e.organization_id = s.organization_id and e.occurred_at >= s.attempted_at
        and e.occurred_at < s.attempted_at + interval '30 days' and e.kind in ('reply', 'positive_reply', 'negative_reply', 'not_now')
      order by e.occurred_at limit 1) as reply,
     s.status in ('bounced', 'complaint') or exists (select 1 from private.growth_delivery_events d where d.message_id = s.id and d.kind in ('bounced', 'complaint')) as bounced
   from sent s),
 arms as (
   select a.key as arm, a.value as value, count(*) as sent, count(*) filter (where o.reply is not null) as replied,
     count(*) filter (where o.reply = 'positive_reply') as positive, count(*) filter (where o.reply = 'negative_reply') as negative,
     count(*) filter (where o.reply = 'not_now') as not_now, count(*) filter (where o.bounced) as bounced
   from outcome o, jsonb_each_text(o.arms) a group by a.key, a.value)
 select jsonb_build_object(
   'product', p_product, 'days', p_days,
   'sent', (select count(*) from outcome), 'replied', (select count(*) from outcome where reply is not null),
   'positive', (select count(*) from outcome where reply = 'positive_reply'), 'bounced', (select count(*) from outcome where bounced),
   'arms', coalesce((select jsonb_agg(jsonb_build_object('arm', arm, 'value', value, 'sent', sent, 'replied', replied, 'positive', positive,
       'negative', negative, 'notNow', not_now, 'bounced', bounced) order by arm, value) from arms), '[]'::jsonb),
   'memos', coalesce((select jsonb_agg(jsonb_build_object('version', memo_version, 'sent', n, 'replied', r) order by memo_version) from (
       select memo_version, count(*) n, count(*) filter (where reply is not null) r from outcome where memo_version is not null group by memo_version) x), '[]'::jsonb),
   'objections', coalesce((select jsonb_object_agg(objection, n) from (
       select e.facts ->> 'objection' as objection, count(*) n from private.customer_activity_events e
        where e.product = p_product and e.facts ? 'objection' and e.occurred_at >= now() - make_interval(days => p_days)
          and e.facts ->> 'objection' ~ '^[a-z_]{1,30}$' group by 1) x), '{}'::jsonb),
   'ownerNotes', coalesce((select jsonb_agg(left(note, 300)) from (
       select a.decision_note as note from private.agent_actions a join private.growth_messages m on m.action_id = a.id
        join private.growth_opportunities o on o.id = m.opportunity_id
        where a.kind = 'growth.message' and a.status = 'rejected' and o.product = p_product and nullif(btrim(a.decision_note), '') is not null
          and a.decided_at >= now() - make_interval(days => p_days) and m.primary_message_id is null
        order by a.decided_at desc limit 5) x), '[]'::jsonb),
   -- Why drafts were thrown away by the code checks (the pipeline sweep's `rejected` counts, draft.mjs codes), across products.
   'draftChecks', coalesce((select jsonb_object_agg(code, n) from (
       select r.key as code, sum((r.value #>> '{}')::numeric)::integer as n
       from private.agent_tasks t cross join lateral jsonb_each(case when jsonb_typeof(t.result -> 'rejected') = 'object' then t.result -> 'rejected' else '{}'::jsonb end) r
       where t.kind = 'growth.pipeline' and t.status = 'done' and t.finished_at >= now() - make_interval(days => p_days)
         and r.key ~ '^[a-z_]{1,80}$' and jsonb_typeof(r.value) = 'number'
       group by 1 order by 2 desc limit 30) x), '{}'::jsonb),
   'rejectedDrafts', (select count(*) from private.agent_actions a join private.growth_messages m on m.action_id = a.id
        join private.growth_opportunities o on o.id = m.opportunity_id
        where a.kind = 'growth.message' and a.status = 'rejected' and o.product = p_product and a.decided_at >= now() - make_interval(days => p_days)
          and m.primary_message_id is null))
 );
end; $$;

-- Owner: the evidence, each touch with everyone it went to (its primary row first, then its colleague rows), and the activity.
create or replace function hub.growth_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$ begin
 perform hub.authorize_app_admin();
 return jsonb_build_object('evidence',(select coalesce(jsonb_agg(to_jsonb(e)),'[]') from private.growth_evidence e where opportunity_id=p_id),
 'messages',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select m.id,m.subject,m.body,m.status,m.citations,m.model_generated,m.variant,m.created_at,m.attempted_at,m.delivered_at,
   (select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',rc.name,'role',rc.role,'email',rc.email,'status',r.status,'attempted_at',r.attempted_at,
       'primary',r.primary_message_id is null) order by r.primary_message_id is not null,r.created_at,r.id),'[]'::jsonb)
     from private.growth_messages r join private.growth_contacts rc on rc.id=r.contact_id
     where (r.id=m.id or r.primary_message_id=m.id) and (r.withdrawn_at is null or r.id=m.id)) as recipients
   from private.growth_messages m where m.opportunity_id=p_id and m.primary_message_id is null order by m.created_at desc limit 50) x),
 'events',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select e.kind,e.occurred_at,e.facts from private.customer_activity_events e join private.growth_opportunities o on o.organization_id=e.organization_id and o.product=e.product where o.id=p_id order by e.occurred_at desc limit 100) x));
end; $$;

-- Every redefinition above keeps its signature, so its grants are kept; the gate below checks them.
do $$
declare f text; r text;
begin
  foreach f in array array['private.growth_colleague_candidates(integer)', 'private.growth_colleague_draft(uuid,uuid,text)', 'private.growth_propose(uuid,uuid)',
    'private.growth_claim_message(uuid,uuid)', 'private.growth_finish_message(uuid,text,text)', 'private.growth_delivery_event(text,uuid,text,timestamptz,boolean)',
    'private.growth_snapshot(integer)', 'private.growth_reengage(integer)', 'private.growth_learning_facts(text,integer)'] loop
    if not exists (select 1 from pg_proc where oid = f::regprocedure and prosecdef and proconfig @> array['search_path=""'] and prosrc like '%require_hub_app_server%')
       or not has_function_privilege('hub_app_server', f, 'execute') then
      raise exception '% must stay a guarded Hub server function', f using errcode = '55000';
    end if;
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, f, 'execute') then raise exception '% exposed to %', f, r using errcode = '55000'; end if;
    end loop;
  end loop;
  if has_function_privilege('anon', 'hub.growth_detail(uuid)', 'execute') or not has_function_privilege('authenticated', 'hub.growth_detail(uuid)', 'execute') then
    raise exception 'Only the owner reads an opportunity''s history' using errcode = '55000';
  end if;
end $$;
