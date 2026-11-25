-- Cold email reaches only confirmed shared addresses, and the day's emails are spread over the send hours (the Nov 24 measurement,
-- docs/AI_WORKFORCE_REVIEW_2026-11-17_TEAM.md; owner decision 2026-11-24).
--
-- What the week showed: every cold email that bounced (4 of 55) went to a shared address (info@ and the like, from the Medicare record or
-- the agency's website) that its mail server never confirmed: 4 of the 26 such addresses written to bounced, and none of the 21
-- addresses a mail server or the verification service had confirmed. The bounce guard tripped on November 24. And all ten of each day's
-- emails left at 8:00 Eastern, the moment the hours opened.
--
-- 1. Settings → Customer growth → "Check an address before the first email", Strict, now also means: a shared address is written to only
--    once a mail server or the verification service confirmed it (mailbox_result 'verified'). One that cannot be confirmed (a catch-all
--    domain, or no clear answer after three tries) goes to the owner's review, its waiting emails are cancelled, its business's
--    never-emailed opportunities are free for another contact and the people finder looks there again for a named person, as for an
--    address whose mailbox does not exist. A named person's address keeps its rule (held while unchecked, to review after three tries).
--    Check and Off are unchanged.
-- 2. Shared addresses never written to that used their three tries while the verification service refused every check (from November
--    18) are given one more try, so the service is asked once it answers again.
-- 3. Settings → Customer growth → "Spread the day's cold emails over the send hours" (growth.send_spread, off): a cold email waits until
--    the day's last one is the send hours divided by the day's number old (8 to 16 and 10 a day: 48 minutes). The send claim refuses
--    with 'paced' and the deferral waits for that moment. Only with both send hours set.
--
-- Nothing is sent by this migration. 20261124159000_first_replies_contract.sql declares platform.agents.first-replies.v1; the server
-- handles 'paced' whatever the contract, and the owner turns the new switch on once this release is live (an older server would take
-- 'paced' for an answer and never send the email).
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values ('growth.send_spread', 'flag') on conflict (key) do nothing;

-- ---- 1. Strict: shared addresses only once confirmed -------------------------------------------------------------------------------

-- Why an email of this purpose to this contact should wait now, or null. Cold email only: a reply to someone who wrote in, or a
-- customer's email, never waits here. 'address_unconfirmed' (Strict): a shared address not yet confirmed.
create or replace function private.growth_hold_for(p_contact uuid, p_purpose text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare c private.growth_contacts%rowtype; v_mode text; begin
 select * into c from private.growth_contacts where id = p_contact;
 if not found or private.growth_message_class('marketing_manager', p_purpose, c.source_kind) is distinct from 'growth.cold_email' then return null; end if;
 if (private.growth_bounce_guard() ->> 'tripped')::boolean then return 'bounce_guard'; end if;
 v_mode := private.growth_presend_mode();
 if v_mode = 'off' or c.eligibility <> 'permitted' then return null; end if;
 -- Only the first email to an address waits for its check: one already written to has its own delivery record.
 if exists (select 1 from private.growth_messages x where x.contact_id = c.id and x.attempted_at is not null) then return null; end if;
 -- Rejected addresses are 'undeliverable', and the send claim cancels their emails.
 if c.mailbox_result = 'rejected' then return null; end if;
 -- Strict (20261124150000_first_replies.sql): a shared address is written to only once a mail server or the verification service
 -- confirmed it. private.growth_address_unconfirmed sends one that can no longer be confirmed to review.
 if v_mode = 'strict' and c.source_kind = 'role_address' and c.mailbox_result is distinct from 'verified' then return 'address_unconfirmed'; end if;
 if c.mailbox_result in ('verified', 'catch_all') then return null; end if;
 if c.mailbox_checks >= private.growth_mailbox_tries() then return null; end if;
 return 'address_unchecked';
end; $$;
revoke all on function private.growth_hold_for(uuid, text) from public, anon, authenticated, service_role, hub_app_server;

-- Whether a shared address can still be confirmed: never asked, or asked without an answer fewer than three times. A catch-all domain
-- accepts any address, so its answer never changes.
create or replace function private.growth_confirmable(c private.growth_contacts) returns boolean
language sql stable set search_path = '' as $$
  select c.mailbox_result is null or (c.mailbox_result in ('unknown', 'unreachable') and c.mailbox_checks < private.growth_mailbox_tries());
$$;
revoke all on function private.growth_confirmable(private.growth_contacts) from public, anon, authenticated, service_role, hub_app_server;

-- A permitted contact the checks will never confirm goes to the owner's review: its waiting emails are cancelled and, like an address
-- whose mailbox does not exist, its business's never-emailed opportunities are free for another contact and the people finder looks
-- there again. Called under the growth workflow lock. Returns the emails cancelled.
create or replace function private.growth_contact_to_review(p_contact uuid, p_result text) returns integer
language plpgsql security definer set search_path = '' as $$
declare c private.growth_contacts%rowtype; v_cancelled integer := 0; begin
 select * into c from private.growth_contacts where id = p_contact for update;
 if not found or c.eligibility <> 'permitted' then return 0; end if;
 update private.growth_contacts set eligibility = 'review', version = version + 1 where id = c.id;
 update private.growth_messages set status = 'cancelled' where contact_id = c.id and status in ('draft', 'proposed');
 get diagnostics v_cancelled = row_count;
 update private.growth_opportunities o set contact_id = null, version = o.version + 1, updated_at = now()
  where o.contact_id = c.id and not exists (select 1 from private.growth_messages m where m.opportunity_id = o.id and m.attempted_at is not null);
 update private.growth_organizations set people_searched_at = null where id = c.organization_id;
 insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
 values (null, 'growth.address_checked', 'growth', c.organization_id, jsonb_build_object('contact', c.id, 'result', p_result, 'eligibility', 'review',
   'unconfirmed', true));
 return v_cancelled;
end; $$;
revoke all on function private.growth_contact_to_review(uuid, text) from public, anon, authenticated, service_role, hub_app_server;

-- Before a send or a draft: a shared address Strict holds that can no longer be confirmed goes to review now, so its email does not
-- wait for ever. Returns the hold, 'address_review' when the address was just sent to review.
create or replace function private.growth_hold_settle(p_contact uuid, p_purpose text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_hold text := private.growth_hold_for(p_contact, p_purpose); c private.growth_contacts%rowtype; begin
 if v_hold is distinct from 'address_unconfirmed' then return v_hold; end if;
 perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 select * into c from private.growth_contacts where id = p_contact;
 if private.growth_confirmable(c) then return v_hold; end if;
 perform private.growth_contact_to_review(c.id, coalesce(c.mailbox_result, 'unknown'));
 return 'address_review';
end; $$;
revoke all on function private.growth_hold_settle(uuid, text) from public, anon, authenticated, service_role, hub_app_server;

-- Server, before the send claim: why this message should wait (the executor defers it for 15 minutes), or null.
create or replace function private.growth_send_hold(p_message uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare m private.growth_messages%rowtype; begin
 perform private.require_hub_app_server();
 perform private.growth_bounce_guard_latch();
 select * into m from private.growth_messages where id = p_message;
 -- The claim decides everything else, a message already sent or cancelled included.
 if not found or m.status not in ('draft', 'proposed') then return null; end if;
 return private.growth_hold_settle(m.contact_id, m.purpose);
end; $$;
revoke all on function private.growth_send_hold(uuid) from public, anon, authenticated, service_role;
grant execute on function private.growth_send_hold(uuid) to hub_app_server;

-- Server, before a first email is drafted: the same hold, so no model call is spent on an address that will wait or go to review.
create or replace function private.growth_draft_hold(p_contact uuid) returns text
language plpgsql security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 perform private.growth_bounce_guard_latch();
 return private.growth_hold_settle(p_contact, 'marketing');
end; $$;
revoke all on function private.growth_draft_hold(uuid) from public, anon, authenticated, service_role;
grant execute on function private.growth_draft_hold(uuid) to hub_app_server;

-- Server: the mail server's (or the verification service's) answer for one address. 'rejected' makes the contact undeliverable. In
-- Strict, the last of three unanswered tries, and a shared address on a catch-all domain, send the address to review. Returns what changed.
create or replace function private.growth_mailbox_record(p_contact uuid, p_result text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.growth_contacts%rowtype; v_review boolean := false; v_cancelled integer := 0; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_result is null or p_result not in ('verified', 'rejected', 'catch_all', 'unknown', 'unreachable') then raise exception 'Invalid answer' using errcode = '22023'; end if;
 select * into c from private.growth_contacts where id = p_contact for update;
 if not found then raise exception 'Unknown contact' using errcode = '22023'; end if;
 if c.eligibility = 'permitted' and p_result <> 'rejected' and private.growth_presend_mode() = 'strict' then
  v_review := (p_result in ('unknown', 'unreachable') and c.mailbox_checks + 1 >= private.growth_mailbox_tries())
    or (p_result = 'catch_all' and c.source_kind = 'role_address');
 end if;
 update private.growth_contacts set mailbox_result = p_result, mailbox_checked_at = now(), mailbox_checks = least(mailbox_checks + 1, 1000),
   eligibility = case when c.eligibility = 'permitted' and p_result = 'rejected' then 'undeliverable' else eligibility end,
   version = version + case when c.eligibility = 'permitted' and p_result = 'rejected' then 1 else 0 end
  where id = c.id;
 if c.eligibility = 'permitted' and p_result = 'rejected' then
  update private.growth_messages set status = 'cancelled' where contact_id = c.id and status in ('draft', 'proposed');
  get diagnostics v_cancelled = row_count;
  -- The business's never-emailed opportunities may take another contact, and the people finder looks there again.
  update private.growth_opportunities o set contact_id = null, version = o.version + 1, updated_at = now()
   where o.contact_id = c.id and not exists (select 1 from private.growth_messages m where m.opportunity_id = o.id and m.attempted_at is not null);
  update private.growth_organizations set people_searched_at = null where id = c.organization_id;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (null, 'growth.address_checked', 'growth', c.organization_id, jsonb_build_object('contact', c.id, 'result', p_result, 'eligibility', 'undeliverable'));
  return jsonb_build_object('result', p_result, 'eligibility', 'undeliverable', 'cancelled', v_cancelled);
 end if;
 if v_review then
  v_cancelled := private.growth_contact_to_review(c.id, p_result);
  return jsonb_build_object('result', p_result, 'eligibility', 'review', 'cancelled', v_cancelled);
 end if;
 return jsonb_build_object('result', p_result, 'eligibility', c.eligibility, 'cancelled', 0);
end; $$;
revoke all on function private.growth_mailbox_record(uuid, text) from public, anon, authenticated, service_role;
grant execute on function private.growth_mailbox_record(uuid, text) to hub_app_server;

-- ---- 2. One more try for shared addresses the verification service never answered for ------------------------------------------------

-- The service gave its last answer on November 17 and refused every check after it, so the shared addresses whose three tries ended
-- after that never had its opinion. Never written to, still permitted: they are asked once more. Once only (the audit row marks it).
do $$
declare v_n integer; begin
 if exists (select 1 from private.audit_events where action = 'growth.address_retry' and metadata ->> 'migration' = '20261124150000') then return; end if;
 update private.growth_contacts c set mailbox_checks = private.growth_mailbox_tries() - 1, mailbox_checked_at = null
  where c.eligibility = 'permitted' and c.source_kind = 'role_address' and c.mailbox_result in ('unknown', 'unreachable')
    and c.mailbox_checks >= private.growth_mailbox_tries() and c.mailbox_checked_at >= '2026-11-18'
    and not exists (select 1 from private.growth_messages m where m.contact_id = c.id and m.attempted_at is not null);
 get diagnostics v_n = row_count;
 insert into private.audit_events(actor_id, action, entity_type, metadata)
 values (null, 'growth.address_retry', 'settings', jsonb_build_object('migration', '20261124150000', 'contacts', v_n));
end $$;

-- ---- 3. The day's cold emails spread over the send hours -----------------------------------------------------------------------------

-- When the next cold email may go: the day's last one (the Eastern day, as the cap counts it) plus the send hours divided by the day's
-- number. Null while "Spread the day's cold emails over the send hours" is off, while the send hours are not both set, or before the
-- day's first.
create or replace function private.growth_cold_pace_at() returns timestamptz
language plpgsql stable set search_path = '' as $$
declare v_from integer; v_until integer; v_cap integer; v_last timestamptz; begin
 if (select s.value from private.hub_settings s where s.key = 'growth.send_spread') is distinct from 'true'::jsonb then return null; end if;
 select case when jsonb_typeof(s.value) = 'number' and (s.value #>> '{}') ~ '^[0-9]{1,2}$' then (s.value #>> '{}')::integer end into v_from
   from private.hub_settings s where s.key = 'growth.send_from_hour';
 select case when jsonb_typeof(s.value) = 'number' and (s.value #>> '{}') ~ '^[0-9]{1,2}$' then (s.value #>> '{}')::integer end into v_until
   from private.hub_settings s where s.key = 'growth.send_until_hour';
 if v_from is null or v_until is null or v_from > 23 or v_until < 1 or v_until > 24 or v_from >= v_until then return null; end if;
 v_cap := coalesce(private.growth_cold_email_cap(), 10);
 select max(x.attempted_at) into v_last from private.growth_messages x join private.growth_contacts xc on xc.id = x.contact_id
  where x.attempted_at >= private.agent_day_start()
    and private.growth_message_class('marketing_manager', x.purpose, xc.source_kind) = 'growth.cold_email';
 if v_last is null then return null; end if;
 return v_last + make_interval(mins => greatest(1, (v_until - v_from) * 60 / v_cap));
end; $$;
revoke all on function private.growth_cold_pace_at() from public, anon, authenticated, service_role, hub_app_server;

-- The send claim refuses a cold email that would come too soon after the day's last one.
do $$
declare
  d text := pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure);
  anchor constant text := 'if v_cold and private.growth_next_send_at(now(), private.growth_org_zone(o.organization_id))>now() then return jsonb_build_object(''send'',false,''status'',''outside_hours''); end if;';
  added constant text := E'\n -- Spread over the hours (20261124150000_first_replies.sql): with "Spread the day''s cold emails over the send hours" on, a cold email\n -- waits until the day''s last one is the send hours divided by the day''s number old.\n if v_cold and private.growth_cold_pace_at()>now() then return jsonb_build_object(''send'',false,''status'',''paced''); end if;';
begin
  if position('growth_cold_pace_at' in d) > 0 then return; end if;
  if position(anchor in d) = 0 then raise exception 'The send claim changed; update this migration' using errcode = '55000'; end if;
  execute replace(d, anchor, anchor || added);
end $$;

-- A growth email that could not go now waits (20261117190000_growth_priority.sql, 20261118130000_growth_local_send_time.sql): over the
-- day's cap, with "Send to the best prospects first" on, until the next Eastern day; spread over the hours, until the day's last cold
-- email is old enough; outside the send hours, until the next opening; a cold email never before the next opening in its agency's zone;
-- anything else 15 minutes.
create or replace function private.growth_defer_action(p_id uuid, p_execution integer, p_reason text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_at timestamptz := now() + interval '15 minutes'; v_cold boolean; v_zone text; v_deferred boolean; begin
 perform private.require_hub_app_server();
 if p_reason in ('daily_limit', 'outside_hours', 'paced') then
  select private.growth_message_class(a.agent_key, m.purpose, c.source_kind) = 'growth.cold_email', private.growth_org_zone(c.organization_id) into v_cold, v_zone
    from private.agent_actions a join private.growth_messages m on m.action_id = a.id join private.growth_contacts c on c.id = m.contact_id
   where a.id = p_id order by m.created_at desc limit 1;
  if p_reason = 'daily_limit' and private.growth_send_priority_on() then
   v_at := (date_trunc('day', now() at time zone 'America/New_York') + interval '1 day') at time zone 'America/New_York';
  end if;
  if p_reason = 'paced' then v_at := greatest(coalesce(private.growth_cold_pace_at(), v_at), now() + interval '1 minute'); end if;
  if coalesce(v_cold, false) then v_at := private.growth_next_send_at(v_at, coalesce(v_zone, 'America/New_York')); end if;
 end if;
 update private.agent_actions set status=case when decided_by is null then 'auto_approved' else 'approved' end,
 executing_at=null,not_before=v_at,updated_at=now()
 where id=p_id and kind='growth.message' and status='executing' and executions=p_execution
 returning true into v_deferred;
 return coalesce(v_deferred,false);
end; $$;
revoke all on function private.growth_defer_action(uuid, integer, text) from public, anon, authenticated, service_role;
grant execute on function private.growth_defer_action(uuid, integer, text) to hub_app_server;
