-- Check an address with the business's own mail server before the first email to it, and pause cold email when it bounces
-- (owner decision 2026-11-16, docs/AI_WORKFORCE_REVIEW_2026-11-16.md).
--
-- Why. Of the first 22 cold emails, 3 bounced (14%), all to addresses read from the agencies' own websites (info@ and the like). The
-- owner's own rule is to raise "Most cold emails a day" only while bounces stay under 2%. The Hub already asks a business's mail
-- server whether a guessed address of a named person exists, sending nothing (server/growth/mailbox.mjs); this migration lets the
-- Marketing Manager ask the same question of every address before the first cold email to it, and stops cold email on its own when
-- bounces or a complaint show the sending is doing harm.
--
-- 1. Settings (Settings -> Customer growth):
--    - "Check an address before the first email" (growth.presend_check): off (as before); check, where an address the business's
--      mail server says does not exist is never written to, and one it could not answer for after three tries over two days is
--      written to as before; or strict, where such an unanswered address waits for the owner's review instead.
--    - "Pause cold email at this bounce rate" (growth.bounce_guard_percent): empty (off) or 1 to 50. When the cold emails sent in
--      the last seven days (at least 20 of them) bounced above this percent, or anyone marked one as spam, cold email waits until
--      the owner resumes it on Growth. A soft bounce (a full mailbox, a server that was down) does not count: only an address that
--      bounced for good, which the Hub then never writes to again. The seven days start no earlier than the owner last saved the
--      setting or resumed, so a bounce from before the guard was switched on or resumed never trips it.
-- 2. private.growth_contacts gains the mail server's last answer (mailbox_result: verified, rejected, catch_all, unknown or
--    unreachable), when it was asked and how often. An address that a person's mail server confirmed when the people finder found it
--    is already verified.
-- 3. A contact whose mail server said the mailbox does not exist becomes 'undeliverable', a new eligibility: never written to (every
--    send check reads 'permitted' only), its unsent emails cancelled, its never-emailed opportunities free for another contact, and
--    its business back on the people finder's list. Unlike 'opted_out' it says nothing about the business's wishes, so it never
--    blocks a named person there. The owner can still change it on Growth.
-- 4. private.growth_mailbox_candidates / private.growth_mailbox_record: the Marketing Manager's growth.verify task (every half hour)
--    asks about permitted cold-email addresses never yet written to, those with an email waiting first, then the best fit.
-- 5. private.growth_send_hold (before the send claim) and private.growth_draft_hold (before a first email is drafted): a cold email
--    waits while the guard is tripped, and a first email to an address waits for the address's check. Nothing here loosens a send
--    check: the claim (private.growth_claim_message) is unchanged and still decides every send.
-- 6. hub.growth_send_guard / hub.growth_send_guard_resume: the guard's state on Growth, and the owner's "Resume cold email".
--
-- Nothing is sent by this migration. 20261116100100_growth_address_check_contract.sql declares platform.agents.growth-address-check.v1,
-- and the server uses these functions only once it is declared.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.presend_check', 'text'),
  ('growth.bounce_guard_percent', 'number')
on conflict (key) do nothing;

alter table private.growth_contacts add column if not exists mailbox_result text
  check (mailbox_result in ('verified', 'rejected', 'catch_all', 'unknown', 'unreachable'));
alter table private.growth_contacts add column if not exists mailbox_checked_at timestamptz;
alter table private.growth_contacts add column if not exists mailbox_checks integer not null default 0 check (mailbox_checks between 0 and 1000);

alter table private.growth_contacts drop constraint if exists growth_contacts_eligibility_check;
alter table private.growth_contacts add constraint growth_contacts_eligibility_check
  check (eligibility in ('review', 'permitted', 'opted_out', 'undeliverable'));

-- A named person's address the mail server confirmed when the people finder found it.
update private.growth_contacts c set mailbox_result = 'verified', mailbox_checked_at = coalesce(p.observed_at, c.verified_at, now()), mailbox_checks = 1
  from private.growth_people p
 where p.contact_id = c.id and p.address_found = 'mail_server' and c.mailbox_result is null;

-- The owner's last "Resume cold email". One row.
create table if not exists private.growth_send_guard (
  id boolean primary key default true check (id),
  resumed_at timestamptz,
  resumed_by uuid
);
insert into private.growth_send_guard (id) values (true) on conflict (id) do nothing;
alter table private.growth_send_guard enable row level security;
revoke all on private.growth_send_guard from public, anon, authenticated, service_role, hub_app_server;

-- The owner's choice for checking addresses: 'off', 'check' or 'strict'.
create or replace function private.growth_presend_mode() returns text
language sql stable set search_path = '' as $$
  select coalesce((select case when jsonb_typeof(s.value) = 'string' and (s.value #>> '{}') in ('off', 'check', 'strict') then s.value #>> '{}' end
                     from private.hub_settings s where s.key = 'growth.presend_check'), 'off');
$$;
revoke all on function private.growth_presend_mode() from public, anon, authenticated, service_role, hub_app_server;

-- How many answers the mail server may fail to give (unknown or unreachable) before an address is decided without one.
create or replace function private.growth_mailbox_tries() returns integer language sql immutable set search_path = '' as $$ select 3 $$;
revoke all on function private.growth_mailbox_tries() from public, anon, authenticated, service_role, hub_app_server;

-- The bounce guard: whether cold email waits, and the counts behind it. Hard bounces only (the address was suppressed for good).
create or replace function private.growth_bounce_guard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_pct integer; v_saved timestamptz; v_resumed timestamptz; v_since timestamptz; v_sent integer; v_bounced integer; v_complaints integer; begin
 select case when jsonb_typeof(s.value) = 'number' and (s.value #>> '{}') ~ '^[0-9]{1,2}$' and (s.value #>> '{}')::integer between 1 and 50
             then (s.value #>> '{}')::integer end, s.changed_at
   into v_pct, v_saved from private.hub_settings s where s.key = 'growth.bounce_guard_percent';
 if v_pct is null then return jsonb_build_object('on', false, 'tripped', false); end if;
 select resumed_at into v_resumed from private.growth_send_guard where id;
 v_since := greatest(now() - interval '7 days', coalesce(v_saved, '-infinity'::timestamptz), coalesce(v_resumed, '-infinity'::timestamptz));
 select count(*),
        count(*) filter (where x.status = 'bounced' and exists (select 1 from private.email_suppressions s where s.email_hash = encode(extensions.digest(xc.email, 'sha256'), 'hex'))),
        count(*) filter (where x.status = 'complaint')
   into v_sent, v_bounced, v_complaints
   from private.growth_messages x join private.growth_contacts xc on xc.id = x.contact_id
  where x.attempted_at >= v_since and private.growth_message_class('marketing_manager', x.purpose, xc.source_kind) = 'growth.cold_email';
 return jsonb_build_object('on', true, 'percent', v_pct, 'since', v_since, 'sent', v_sent, 'bounced', v_bounced, 'complaints', v_complaints,
   'tripped', v_complaints > 0 or (v_sent >= 20 and v_bounced * 100 > v_pct * v_sent));
end; $$;
revoke all on function private.growth_bounce_guard() from public, anon, authenticated, service_role, hub_app_server;

-- Why an email of this purpose to this contact should wait now, or null. Cold email only: a reply to someone who wrote in, or a
-- customer's email, never waits here.
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
 if c.mailbox_result in ('verified', 'catch_all') then return null; end if;
 -- Rejected addresses are 'undeliverable', and the send claim cancels their emails.
 if c.mailbox_result = 'rejected' then return null; end if;
 if c.mailbox_checks >= private.growth_mailbox_tries() then return null; end if;
 return 'address_unchecked';
end; $$;
revoke all on function private.growth_hold_for(uuid, text) from public, anon, authenticated, service_role, hub_app_server;

-- Server, before the send claim: why this message should wait (the executor defers it for 15 minutes), or null.
create or replace function private.growth_send_hold(p_message uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare m private.growth_messages%rowtype; begin
 perform private.require_hub_app_server();
 select * into m from private.growth_messages where id = p_message;
 -- The claim decides everything else, a message already sent or cancelled included.
 if not found or m.status not in ('draft', 'proposed') then return null; end if;
 return private.growth_hold_for(m.contact_id, m.purpose);
end; $$;
revoke all on function private.growth_send_hold(uuid) from public, anon, authenticated, service_role;
grant execute on function private.growth_send_hold(uuid) to hub_app_server;

-- Server, before a first outreach email is drafted: why to wait (no model call is paid for an address that may not exist), or null.
create or replace function private.growth_draft_hold(p_contact uuid) returns text
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 return private.growth_hold_for(p_contact, 'marketing');
end; $$;
revoke all on function private.growth_draft_hold(uuid) from public, anon, authenticated, service_role;
grant execute on function private.growth_draft_hold(uuid) to hub_app_server;

-- Server: the addresses to ask about next, while checking is on. Permitted cold-email addresses never yet written to, of businesses
-- the Marketing Manager prospects (never internal, never a customer), whose check is due: never asked, or asked without an answer
-- fewer than three times and not in the last 16 hours (a greylisting server answers on a later try). Those with an email waiting
-- first, then the best fit.
create or replace function private.growth_mailbox_candidates(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 if p_limit is null or p_limit < 1 or p_limit > 50 then raise exception 'Invalid page' using errcode = '22023'; end if;
 if private.growth_presend_mode() = 'off' then return '[]'::jsonb; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'email', x.email) order by x.waiting desc, x.fit desc nulls last, x.id), '[]'::jsonb) from (
  select c.id, c.email,
    exists (select 1 from private.growth_messages m where m.contact_id = c.id and m.status in ('draft', 'proposed')) as waiting,
    (select max(o.fit) from private.growth_opportunities o where o.organization_id = c.organization_id and o.owner_agent = 'marketing_manager') as fit
  from private.growth_contacts c join private.growth_organizations g on g.id = c.organization_id
  where c.eligibility = 'permitted' and c.source_kind in ('role_address', 'enriched', 'imported')
    and not g.internal and g.tenant_id is null
    and (c.mailbox_result is null
         or (c.mailbox_result in ('unknown', 'unreachable') and c.mailbox_checks < private.growth_mailbox_tries()
             and (c.mailbox_checked_at is null or c.mailbox_checked_at < now() - interval '16 hours')))
    and not exists (select 1 from private.growth_messages m where m.contact_id = c.id and m.attempted_at is not null)
    and exists (select 1 from private.growth_opportunities o where o.organization_id = c.organization_id and o.owner_agent = 'marketing_manager'
                  and o.stage in ('identified', 'researched', 'qualified'))
    and not exists (select 1 from private.email_suppressions s where s.email_hash = encode(extensions.digest(c.email, 'sha256'), 'hex'))
  order by 3 desc, 4 desc nulls last, c.id limit p_limit) x);
end; $$;
revoke all on function private.growth_mailbox_candidates(integer) from public, anon, authenticated, service_role;
grant execute on function private.growth_mailbox_candidates(integer) to hub_app_server;

-- Server: the mail server's answer for one address. 'rejected' makes the contact undeliverable (above). In strict mode, the last of
-- three unanswered tries sends the address to the owner's review. Returns what changed.
create or replace function private.growth_mailbox_record(p_contact uuid, p_result text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.growth_contacts%rowtype; v_eligibility text; v_cancelled integer := 0; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_result is null or p_result not in ('verified', 'rejected', 'catch_all', 'unknown', 'unreachable') then raise exception 'Invalid answer' using errcode = '22023'; end if;
 select * into c from private.growth_contacts where id = p_contact for update;
 if not found then raise exception 'Unknown contact' using errcode = '22023'; end if;
 v_eligibility := c.eligibility;
 if c.eligibility = 'permitted' and p_result = 'rejected' then v_eligibility := 'undeliverable';
 elsif c.eligibility = 'permitted' and p_result in ('unknown', 'unreachable') and c.mailbox_checks + 1 >= private.growth_mailbox_tries()
   and private.growth_presend_mode() = 'strict' then v_eligibility := 'review';
 end if;
 update private.growth_contacts set mailbox_result = p_result, mailbox_checked_at = now(), mailbox_checks = least(mailbox_checks + 1, 1000),
   eligibility = v_eligibility, version = version + case when v_eligibility <> c.eligibility then 1 else 0 end
  where id = c.id;
 if v_eligibility <> c.eligibility then
  update private.growth_messages set status = 'cancelled' where contact_id = c.id and status in ('draft', 'proposed');
  get diagnostics v_cancelled = row_count;
  if v_eligibility = 'undeliverable' then
   -- The business's never-emailed opportunities may take another contact, and the people finder looks there again.
   update private.growth_opportunities o set contact_id = null, version = o.version + 1, updated_at = now()
    where o.contact_id = c.id and not exists (select 1 from private.growth_messages m where m.opportunity_id = o.id and m.attempted_at is not null);
   update private.growth_organizations set people_searched_at = null where id = c.organization_id;
  end if;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (null, 'growth.address_checked', 'growth', c.organization_id, jsonb_build_object('contact', c.id, 'result', p_result, 'eligibility', v_eligibility));
 end if;
 return jsonb_build_object('result', p_result, 'eligibility', v_eligibility, 'cancelled', v_cancelled);
end; $$;
revoke all on function private.growth_mailbox_record(uuid, text) from public, anon, authenticated, service_role;
grant execute on function private.growth_mailbox_record(uuid, text) to hub_app_server;

-- Server: the guard's state, for the Marketing Manager's daily alert.
create or replace function private.growth_send_guard_state() returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 return private.growth_bounce_guard();
end; $$;
revoke all on function private.growth_send_guard_state() from public, anon, authenticated, service_role;
grant execute on function private.growth_send_guard_state() to hub_app_server;

-- The owner: the guard's state on Growth, and checking's counts.
create or replace function hub.growth_send_guard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform hub.authorize_app_admin();
 return private.growth_bounce_guard() || jsonb_build_object('mode', private.growth_presend_mode(),
   'resumedAt', (select resumed_at from private.growth_send_guard where id),
   'addresses', (select jsonb_build_object(
      'verified', count(*) filter (where mailbox_result = 'verified'),
      'catchAll', count(*) filter (where mailbox_result = 'catch_all'),
      'undeliverable', count(*) filter (where eligibility = 'undeliverable'),
      'unanswered', count(*) filter (where mailbox_result in ('unknown', 'unreachable')),
      'unchecked', count(*) filter (where mailbox_result is null and eligibility = 'permitted'))
    from private.growth_contacts where source_kind in ('role_address', 'enriched', 'imported')));
end; $$;
revoke all on function hub.growth_send_guard() from public, anon, service_role;
grant execute on function hub.growth_send_guard() to authenticated;

-- The owner's "Resume cold email": the seven days start again now, so the bounces that tripped the guard no longer count.
create or replace function hub.growth_send_guard_resume() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_before jsonb; begin
 v_actor := (hub.authorize_app_command() ->> 'user_id')::uuid;
 perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 v_before := private.growth_bounce_guard();
 update private.growth_send_guard set resumed_at = now(), resumed_by = v_actor where id;
 insert into private.audit_events(actor_id, action, entity_type, metadata)
 values (v_actor, 'growth.cold_email_resumed', 'growth', jsonb_build_object('sent', v_before -> 'sent', 'bounced', v_before -> 'bounced',
   'complaints', v_before -> 'complaints', 'tripped', v_before -> 'tripped'));
 return private.growth_bounce_guard();
end; $$;
revoke all on function hub.growth_send_guard_resume() from public, anon, service_role;
grant execute on function hub.growth_send_guard_resume() to authenticated;

-- The same as 20261113290000_growth_people_finder.sql, except that a contact whose mailbox does not exist no longer keeps its business
-- off the list: the people finder looks there again for someone else.
create or replace function private.growth_people_candidates(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 if p_limit is null or p_limit < 1 or p_limit > 20 then raise exception 'Invalid page' using errcode = '22023'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'domain', x.domain, 'name', x.name, 'product', x.product,
   'ccns', x.ccns, 'agencies', x.agencies) order by x.fit desc nulls last, x.id), '[]'::jsonb) from (
  select g.id, g.domain, g.name, min(o.product) as product, max(o.fit) as fit,
    coalesce((select jsonb_agg(t.ccn order by t.ccn) from private.growth_roster_targets t where t.organization_id = g.id), '[]'::jsonb) as ccns,
    coalesce((select jsonb_agg(jsonb_build_object('ccn', t.ccn, 'name', t.name, 'city', t.city, 'state', t.state, 'zip', t.zip,
      'phone', case when t.facts ->> 'phone' ~ '^[0-9]{10}$' then t.facts ->> 'phone' end, 'setting', t.setting) order by t.ccn)
      from private.growth_roster_targets t where t.organization_id = g.id), '[]'::jsonb) as agencies
  from private.growth_organizations g join private.growth_opportunities o on o.organization_id = g.id
  where not g.internal and g.tenant_id is null and g.domain !~ '\.invalid$'
    and o.owner_agent = 'marketing_manager' and o.stage in ('researched', 'qualified')
    and (o.fit >= 60 or exists (select 1 from private.growth_roster_targets t where t.organization_id = g.id))
    and (g.people_searched_at is null or g.people_searched_at < now() - interval '60 days')
    and not exists (select 1 from private.growth_contacts c where c.organization_id = g.id and c.source_kind in ('enriched', 'imported', 'inbound', 'owner')
                      and c.eligibility not in ('opted_out', 'undeliverable'))
    and not exists (select 1 from private.growth_messages m join private.growth_opportunities y on y.id = m.opportunity_id
                      where y.organization_id = g.id and m.purpose = 'marketing' and m.attempted_at is not null)
  group by g.id, g.domain, g.name
  order by max(o.fit) desc nulls last, g.id limit p_limit) x);
end; $$;

insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('marketing_manager', 'growth.verify', 'interval', 1800, null, 'America/New_York', false, now())
on conflict (agent_key, task_kind) do nothing;
