-- Owner-written email sequences (owner handoff 2026-11-27, "Pennsylvania cold email, batch 1"; docs/OWNER_SEQUENCES.md).
--
-- Why. The owner wrote a three-email sequence, word for word, for a list of agencies he chose, with fixed send dates, and asked the AI
-- team to send it in his name and hand him the replies. The Marketing Manager's own cold email writes its own words, lays an Intel email
-- out as a designed page and paces sends by its own rules, so it cannot send the owner's words as written. A sequence is that: the
-- owner's exact subject and body for each person and step, plain text, reviewed on Growth and approved once, then sent by the Marketing
-- Manager on its dates in the owner's morning window.
--
-- 1. Setting (Settings -> Customer growth): "Send your own email sequences" (growth.owner_sequences, off).
-- 2. private.owner_sequences, owner_sequence_recipients, owner_sequence_messages: a sequence, its people and every email it will send,
--    closed to every role. private.owner_sequence_events: the mail service's delivery events, once each.
-- 3. private.outreach_do_not_contact: who said no. An opt-out ("no thanks", "unsubscribe", "remove me" or the like, a complaint or the
--    one-click unsubscribe) is permanent: the address (as its hash), the agency's own mail domain and its CCN. No later sequence takes
--    them, and the Marketing Manager's own cold email never writes to an organization on that domain (growth_outreach_stopped).
-- 4. Owner commands (hub.*): list and read sequences; save a draft (the Hub server prepares it: report links, merge fields); approve a
--    draft; stop a person or a whole sequence; discard a draft. Nothing is sent before the owner approves.
-- 5. Server (private.*, Hub server only): claim the next due email, record how it went, read replies and delivery events, record the
--    one-click unsubscribe and report opens. A claim sends only on a weekday, in the sequence's window (Eastern), on or after the email's
--    date, after the person's previous email went out on an earlier day, under the sequence's daily limit and under 25 prospecting
--    emails a day in all from the growth sender; never to a suppressed or forbidden address or agency, and never while an earlier email
--    to the person is unresolved. Any reply stops the person's emails; an automatic out-of-office reply does not, unless it says the
--    person has left. A bounce stops them; a hard bounce also suppresses the address (no other address is ever guessed).
-- 6. The Support Concierge never answers or acknowledges a sequence's person on its own: their reply waits for the owner
--    (agent_answer_begin, agent_acknowledge_begin refuse 'owner_sequence' for an action nobody approved).
--
-- Nothing is sent by this migration. 20261127150100_owner_sequences_contract.sql declares platform.agents.owner-sequences.v1.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values ('growth.owner_sequences', 'flag') on conflict (key) do nothing;

create table if not exists private.owner_sequences (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  template text not null check (template ~ '^[a-z0-9-]{1,60}$'),
  campaign text not null check (campaign ~ '^[a-z0-9-]{1,60}$'),
  send_dates date[] not null check (cardinality(send_dates) between 1 and 5),
  window_start time not null default '09:00',
  window_end time not null default '11:00',
  daily_limit integer not null default 8 check (daily_limit between 1 and 30),
  sender jsonb not null default '{}' check (jsonb_typeof(sender) = 'object'),
  status text not null default 'draft' check (status in ('draft', 'approved', 'stopped', 'finished')),
  version integer not null default 1 check (version > 0),
  created_by uuid,
  created_at timestamptz not null default now(),
  approved_by uuid,
  approved_at timestamptz,
  stopped_at timestamptz,
  finished_at timestamptz,
  check (window_start < window_end),
  check ((status = 'draft') = (approved_at is null) or status = 'stopped')
);

create table if not exists private.owner_sequence_recipients (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references private.owner_sequences(id) on delete cascade,
  ref text not null check (ref ~ '^[A-Za-z0-9_-]{1,40}$'),
  email text not null check (char_length(email) <= 320 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and email = lower(btrim(email))),
  domain text check (domain is null or domain ~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$'),
  first_name text check (first_name is null or char_length(first_name) between 1 and 60),
  agency text not null check (char_length(agency) between 1 and 200),
  county text not null check (char_length(county) between 1 and 80),
  setting text not null check (setting in ('hha', 'hospice')),
  ccn text check (ccn is null or ccn ~ '^[0-9A-Z]{6}$'),
  report_url text check (report_url is null or report_url ~ '^https://www\.caremetricintel\.com/report/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}(/view)?$'),
  unsubscribe_hash text not null unique check (unsubscribe_hash ~ '^[a-f0-9]{64}$'),
  notes jsonb not null default '{}' check (jsonb_typeof(notes) = 'object' and pg_column_size(notes) <= 4000),
  status text not null default 'active' check (status in ('active', 'stopped', 'finished')),
  stop_reason text check (stop_reason in ('replied', 'opted_out', 'left', 'bounced', 'complaint', 'unsubscribed', 'suppressed', 'do_not_contact', 'owner')),
  replied_at timestamptz,
  stopped_at timestamptz,
  stop_told boolean not null default false,
  first_opened_at timestamptz,
  open_told boolean not null default false,
  created_at timestamptz not null default now(),
  unique (sequence_id, ref),
  unique (sequence_id, email),
  check ((status = 'stopped') = (stop_reason is not null))
);
create index if not exists owner_sequence_recipients_email on private.owner_sequence_recipients(email);
create index if not exists owner_sequence_recipients_domain on private.owner_sequence_recipients(domain) where domain is not null;
create index if not exists owner_sequence_recipients_ref on private.owner_sequence_recipients(ref);

create table if not exists private.owner_sequence_messages (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references private.owner_sequence_recipients(id) on delete cascade,
  step smallint not null check (step between 1 and 5),
  send_on date not null,
  subject text not null check (char_length(subject) between 1 and 150 and subject !~ '[\r\n]'),
  body text not null check (char_length(body) between 1 and 5000),
  status text not null default 'scheduled' check (status in ('scheduled', 'sending', 'accepted', 'delivered', 'failed', 'unknown', 'cancelled', 'bounced', 'complaint')),
  provider_id text check (provider_id is null or char_length(provider_id) <= 200),
  attempted_at timestamptz,
  delivered_at timestamptz,
  unique (recipient_id, step),
  check ((status = 'scheduled') = (attempted_at is null) or status = 'cancelled')
);
create index if not exists owner_sequence_messages_due on private.owner_sequence_messages(send_on) where status = 'scheduled';

create table if not exists private.owner_sequence_events (
  event_id text primary key check (char_length(event_id) between 1 and 200),
  message_id uuid not null references private.owner_sequence_messages(id) on delete cascade,
  kind text not null check (kind in ('delivered', 'bounced', 'complaint', 'unsubscribe')),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists private.outreach_do_not_contact (
  kind text not null check (kind in ('email_hash', 'domain', 'ccn')),
  value text not null check (char_length(value) between 3 and 253),
  reason text not null check (reason in ('opted_out', 'complaint', 'unsubscribed')),
  source text not null check (source ~ '^[a-z0-9_.:-]{1,80}$'),
  created_at timestamptz not null default now(),
  primary key (kind, value),
  check (kind <> 'email_hash' or value ~ '^[a-f0-9]{64}$'),
  check (kind <> 'ccn' or value ~ '^[0-9A-Z]{6}$'),
  check (kind <> 'domain' or value ~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$')
);

alter table private.owner_sequences enable row level security;
alter table private.owner_sequence_recipients enable row level security;
alter table private.owner_sequence_messages enable row level security;
alter table private.owner_sequence_events enable row level security;
alter table private.outreach_do_not_contact enable row level security;
revoke all on private.owner_sequences, private.owner_sequence_recipients, private.owner_sequence_messages, private.owner_sequence_events,
  private.outreach_do_not_contact from public, anon, authenticated, service_role, hub_app_server;

-- ---------------------------------------------------------------------------------------
-- Helpers (no role may run them directly).
-- ---------------------------------------------------------------------------------------

-- Why an address, its agency's domain or its CCN may not be written to, or null.
create or replace function private.owner_sequence_blocked(p_email text, p_domain text, p_ccn text) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from private.outreach_do_not_contact d where d.kind = 'email_hash' and d.value = private.email_hash(p_email))
      or (p_domain is not null and exists (select 1 from private.outreach_do_not_contact d where d.kind = 'domain' and d.value = lower(p_domain)))
      or (p_ccn is not null and exists (select 1 from private.outreach_do_not_contact d where d.kind = 'ccn' and d.value = p_ccn))
      then 'do_not_contact'
    when exists (select 1 from private.email_suppressions s where s.email_hash = private.email_hash(p_email)) then 'suppressed'
  end
$$;

-- The sender's own words in a reply, lower case: everything above the first quoted line, "On ... wrote:", an Outlook header or a forward.
create or replace function private.owner_sequence_own_words(p_body text) returns text
language sql immutable set search_path = '' as $$
  select lower(regexp_replace(E'\n' || left(coalesce(p_body, ''), 20000),
    '\n\s*(>|on .{0,250}wrote\s*:|-{2,}\s*(original|forwarded) message|begin forwarded message|from\s*:\s).*$', '', 'i'))
$$;

-- Forbids an address, its agency's domain (never a free mail service's) and its CCN for good, suppresses the address, and stops every
-- sequence's person on the same address, domain or CCN.
create or replace function private.owner_sequence_forbid(p_recipient uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare r private.owner_sequence_recipients%rowtype; v_domain text;
begin
  select * into r from private.owner_sequence_recipients where id = p_recipient;
  if not found then return; end if;
  v_domain := case when r.domain is not null and not private.growth_free_mail(r.domain) then r.domain end;
  insert into private.outreach_do_not_contact(kind, value, reason, source) values ('email_hash', private.email_hash(r.email), p_reason, 'owner_sequence')
    on conflict do nothing;
  if v_domain is not null then
    insert into private.outreach_do_not_contact(kind, value, reason, source) values ('domain', v_domain, p_reason, 'owner_sequence') on conflict do nothing;
  end if;
  if r.ccn is not null then
    insert into private.outreach_do_not_contact(kind, value, reason, source) values ('ccn', r.ccn, p_reason, 'owner_sequence') on conflict do nothing;
  end if;
  insert into private.email_suppressions(email_hash) values (private.email_hash(r.email)) on conflict do nothing;
  update private.owner_sequence_messages m set status = 'cancelled' from private.owner_sequence_recipients x
   where m.recipient_id = x.id and m.status = 'scheduled' and x.id <> r.id and x.status = 'active'
     and (x.email = r.email or (v_domain is not null and x.domain = v_domain) or (r.ccn is not null and x.ccn = r.ccn));
  update private.owner_sequence_recipients x set status = 'stopped', stop_reason = 'do_not_contact', stopped_at = now()
   where x.id <> r.id and x.status = 'active'
     and (x.email = r.email or (v_domain is not null and x.domain = v_domain) or (r.ccn is not null and x.ccn = r.ccn));
end; $$;

-- Stops one person's emails for `p_reason` (their scheduled emails are cancelled; nothing already sent changes).
create or replace function private.owner_sequence_stop_recipient(p_recipient uuid, p_reason text, p_replied_at timestamptz default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  update private.owner_sequence_recipients set status = 'stopped', stop_reason = p_reason, stopped_at = now(),
    replied_at = coalesce(replied_at, p_replied_at)
   where id = p_recipient and status = 'active' returning id into v_id;
  if v_id is null then return false; end if;
  update private.owner_sequence_messages set status = 'cancelled' where recipient_id = v_id and status = 'scheduled';
  return true;
end; $$;

-- Reads the replies to one person's emails since the first went out: the email's own address, or anyone on the agency's own domain.
-- An opt-out or a "no" forbids the address and the agency for good; an automatic reply that says the person has left stops their emails;
-- an out-of-office reply is noted and stops nothing; any other reply stops their emails. Returns why the person is stopped, or null.
create or replace function private.owner_sequence_read_replies(p_recipient uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare r private.owner_sequence_recipients%rowtype; v_first timestamptz; m record; v_read jsonb; v_own text; v_reason text;
begin
  select * into r from private.owner_sequence_recipients where id = p_recipient for update;
  if not found then return null; end if;
  if r.status <> 'active' then return r.stop_reason; end if;
  select min(attempted_at) into v_first from private.owner_sequence_messages where recipient_id = r.id and attempted_at is not null;
  if v_first is null then return null; end if;
  for m in select cm.id, cm.body, cm.created_at, c.subject from private.communication_messages cm join private.communications c on c.id = cm.communication_id
    where cm.direction = 'inbound' and c.channel = 'email' and c.contact_email is not null and cm.created_at > v_first
      and (lower(btrim(c.contact_email)) = r.email
        or (r.domain is not null and not private.growth_free_mail(r.domain) and split_part(lower(btrim(c.contact_email)), '@', 2) = r.domain))
    order by cm.created_at, cm.id loop
    v_read := private.growth_reply_reading(m.body);
    v_own := private.owner_sequence_own_words(m.body);
    if coalesce((v_read ->> 'optOut')::boolean, false) or v_read ->> 'kind' in ('negative_reply', 'cancel_requested') then
      v_reason := 'opted_out';
    elsif v_own ~ '\m(no longer (with|at|employed|working)|(has|have) (left|retired)|left (the|our) (company|organization|agency|practice)|is no longer|last day (was|at|with))\M' then
      v_reason := 'left';
    elsif v_own ~ '\m(out of (the )?office|automatic reply|auto(-| )?reply|autoreply|on (vacation|leave|holiday|pto)|away from (the|my) (office|desk)|limited access to (my )?e-?mail|returning on|(will|shall) (be )?(back|return))\M'
      or lower(coalesce(m.subject, '')) ~ '\m(automatic reply|auto(-| )?reply|autoreply|out of (the )?office)\M' then
      update private.owner_sequence_recipients set notes = notes || jsonb_build_object('autoReplyAt', m.created_at) where id = r.id;
      continue;
    else
      v_reason := 'replied';
    end if;
    perform private.owner_sequence_stop_recipient(r.id, v_reason, m.created_at);
    if v_reason = 'opted_out' then perform private.owner_sequence_forbid(r.id, 'opted_out'); end if;
    return v_reason;
  end loop;
  return null;
end; $$;

revoke all on function private.owner_sequence_blocked(text, text, text), private.owner_sequence_own_words(text),
  private.owner_sequence_forbid(uuid, text), private.owner_sequence_stop_recipient(uuid, text, timestamptz),
  private.owner_sequence_read_replies(uuid) from public, anon, authenticated, service_role, hub_app_server;

-- Whether an address is, or shares its agency's own domain with, a person of a sequence that was approved in the last 180 days: the
-- Support Concierge never answers such a person on its own.
create or replace function private.owner_sequence_contact(p_email text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_email is not null and exists (select 1 from private.owner_sequence_recipients r join private.owner_sequences s on s.id = r.sequence_id
    where s.status <> 'draft' and s.approved_at > now() - interval '180 days'
      and (r.email = lower(btrim(p_email))
        or (r.domain is not null and not private.growth_free_mail(r.domain) and r.domain = split_part(lower(btrim(p_email)), '@', 2))))
$$;
revoke all on function private.owner_sequence_contact(text) from public, anon, authenticated, service_role, hub_app_server;

-- ---------------------------------------------------------------------------------------
-- Owner commands.
-- ---------------------------------------------------------------------------------------

-- Owner: every sequence, newest first, with its counts.
create or replace function hub.owner_sequences_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
  perform hub.authorize_app_admin();
  return (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
    select s.id, s.name, s.template, s.campaign, s.send_dates as "sendDates", s.status, s.version, s.daily_limit as "dailyLimit",
      s.window_start as "windowStart", s.window_end as "windowEnd", s.created_at, s.approved_at as "approvedAt", s.stopped_at as "stoppedAt",
      (select count(*) from private.owner_sequence_recipients r where r.sequence_id = s.id) as people,
      (select count(*) from private.owner_sequence_recipients r where r.sequence_id = s.id and r.status = 'stopped') as stopped,
      (select count(*) from private.owner_sequence_recipients r where r.sequence_id = s.id and r.stop_reason in ('replied', 'opted_out', 'left')) as replied,
      (select count(*) from private.owner_sequence_recipients r where r.sequence_id = s.id and r.first_opened_at is not null) as opened,
      (select count(*) from private.owner_sequence_messages m join private.owner_sequence_recipients r on r.id = m.recipient_id
        where r.sequence_id = s.id and m.attempted_at is not null) as sent,
      (select count(*) from private.owner_sequence_messages m join private.owner_sequence_recipients r on r.id = m.recipient_id
        where r.sequence_id = s.id and m.status = 'scheduled') as scheduled
    from private.owner_sequences s order by s.created_at desc limit 50) x);
end; $$;

-- Owner: one sequence, every person and every email word for word.
create or replace function hub.owner_sequence_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s private.owner_sequences%rowtype; begin
  perform hub.authorize_app_admin();
  select * into s from private.owner_sequences where id = p_id;
  if not found then raise exception 'Unknown sequence' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', s.id, 'name', s.name, 'template', s.template, 'campaign', s.campaign, 'sendDates', s.send_dates,
    'windowStart', s.window_start, 'windowEnd', s.window_end, 'dailyLimit', s.daily_limit, 'sender', s.sender, 'status', s.status,
    'version', s.version, 'createdAt', s.created_at, 'approvedAt', s.approved_at, 'stoppedAt', s.stopped_at, 'finishedAt', s.finished_at,
    'people', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'ref', r.ref, 'email', r.email, 'firstName', r.first_name,
        'agency', r.agency, 'county', r.county, 'setting', r.setting, 'ccn', r.ccn, 'reportUrl', r.report_url, 'notes', r.notes,
        'status', r.status, 'stopReason', r.stop_reason, 'repliedAt', r.replied_at, 'stoppedAt', r.stopped_at, 'openedAt', r.first_opened_at,
        'blocked', case when s.status = 'draft' then private.owner_sequence_blocked(r.email, r.domain, r.ccn) end,
        'messages', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'step', m.step, 'sendOn', m.send_on, 'subject', m.subject,
            'body', m.body, 'status', m.status, 'attemptedAt', m.attempted_at, 'deliveredAt', m.delivered_at) order by m.step), '[]'::jsonb)
          from private.owner_sequence_messages m where m.recipient_id = r.id)) order by r.ref), '[]'::jsonb)
      from private.owner_sequence_recipients r where r.sequence_id = s.id));
end; $$;

-- Owner (the Hub server prepares the record): saves a draft. Refuses a date that is not a weekday from today on, dates out of order, a
-- duplicate person, a person whose address, agency domain or CCN is forbidden or suppressed, a person already in another approved
-- sequence, and an email whose step or date is not the sequence's.
create or replace function hub.owner_sequence_create(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_id uuid; v_recipient uuid; v_dates date[]; v_today date := (now() at time zone 'America/New_York')::date;
  p jsonb; m jsonb; v_email text; v_domain text; v_ccn text; v_blocked text; i integer;
begin
  v_actor := (hub.authorize_app_command() ->> 'user_id')::uuid;
  perform pg_advisory_xact_lock(hashtextextended('owner.sequences', 0));
  if p_data is null or jsonb_typeof(p_data) <> 'object' or jsonb_typeof(p_data -> 'people') <> 'array' or jsonb_typeof(p_data -> 'sendDates') <> 'array'
    or pg_column_size(p_data) > 600000 then
    raise exception 'Invalid sequence' using errcode = '22023';
  end if;
  if jsonb_array_length(p_data -> 'people') not between 1 and 60 then raise exception 'A sequence holds 1 to 60 people' using errcode = '22023'; end if;
  select array_agg(value::date order by ordinality) into v_dates from jsonb_array_elements_text(p_data -> 'sendDates') with ordinality;
  if coalesce(cardinality(v_dates), 0) not between 1 and 5 then raise exception 'A sequence has 1 to 5 emails' using errcode = '22023'; end if;
  for i in 1 .. cardinality(v_dates) loop
    if v_dates[i] < v_today or extract(isodow from v_dates[i]) > 5 or (i > 1 and v_dates[i] <= v_dates[i - 1]) then
      raise exception 'Each send date is a weekday from today on, in order' using errcode = '22023';
    end if;
  end loop;
  insert into private.owner_sequences(name, template, campaign, send_dates, window_start, window_end, daily_limit, sender, created_by)
  values (p_data ->> 'name', p_data ->> 'template', p_data ->> 'campaign', v_dates, coalesce((p_data ->> 'windowStart')::time, '09:00'),
    coalesce((p_data ->> 'windowEnd')::time, '11:00'), coalesce((p_data ->> 'dailyLimit')::integer, 8), coalesce(p_data -> 'sender', '{}'::jsonb), v_actor)
  returning id into v_id;
  for p in select value from jsonb_array_elements(p_data -> 'people') loop
    v_email := lower(btrim(p ->> 'email')); v_domain := nullif(lower(btrim(coalesce(p ->> 'domain', ''))), ''); v_ccn := nullif(p ->> 'ccn', '');
    v_blocked := private.owner_sequence_blocked(v_email, v_domain, v_ccn);
    if v_blocked is not null then
      raise exception 'Person % may not be emailed (%)', left(p ->> 'ref', 40), v_blocked using errcode = '22023';
    end if;
    if exists (select 1 from private.owner_sequence_recipients r join private.owner_sequences s on s.id = r.sequence_id
      where s.status = 'approved' and r.status = 'active' and (r.email = v_email or (v_ccn is not null and r.ccn = v_ccn))) then
      raise exception 'Person % is already in an approved sequence', left(p ->> 'ref', 40) using errcode = '22023';
    end if;
    insert into private.owner_sequence_recipients(id, sequence_id, ref, email, domain, first_name, agency, county, setting, ccn, report_url, unsubscribe_hash, notes)
    values ((p ->> 'id')::uuid, v_id, p ->> 'ref', v_email, v_domain, nullif(btrim(coalesce(p ->> 'firstName', '')), ''), p ->> 'agency', p ->> 'county', p ->> 'setting',
      v_ccn, nullif(p ->> 'reportUrl', ''), p ->> 'unsubscribeHash', coalesce(p -> 'notes', '{}'::jsonb))
    returning id into v_recipient;
    if jsonb_typeof(p -> 'messages') <> 'array' or jsonb_array_length(p -> 'messages') <> cardinality(v_dates) then
      raise exception 'Each person has one email for each date' using errcode = '22023';
    end if;
    for m in select value from jsonb_array_elements(p -> 'messages') loop
      if (m ->> 'step')::integer not between 1 and cardinality(v_dates) or (m ->> 'sendOn')::date <> v_dates[(m ->> 'step')::integer] then
        raise exception 'Each email is sent on its step''s date' using errcode = '22023';
      end if;
      insert into private.owner_sequence_messages(recipient_id, step, send_on, subject, body)
      values (v_recipient, (m ->> 'step')::integer, (m ->> 'sendOn')::date, m ->> 'subject', m ->> 'body');
    end loop;
  end loop;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'growth.owner_sequence_saved', 'owner_sequence', v_id, jsonb_build_object('people', jsonb_array_length(p_data -> 'people'),
    'emails', cardinality(v_dates), 'template', p_data ->> 'template'));
  return jsonb_build_object('id', v_id, 'version', 1);
end; $$;

-- Owner: approves a draft as it stands. Every person must still be allowed, and its first date must not have passed.
create or replace function hub.owner_sequence_approve(p_id uuid, p_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; s private.owner_sequences%rowtype; v_ref text;
begin
  v_actor := (hub.authorize_app_command() ->> 'user_id')::uuid;
  perform pg_advisory_xact_lock(hashtextextended('owner.sequences', 0));
  select * into s from private.owner_sequences where id = p_id for update;
  if not found then raise exception 'Unknown sequence' using errcode = 'P0002'; end if;
  if s.status <> 'draft' or s.version <> p_version then raise exception 'Refresh this sequence' using errcode = '40001'; end if;
  if s.send_dates[1] < (now() at time zone 'America/New_York')::date then
    raise exception 'The first send date has passed; prepare the sequence again' using errcode = '22023';
  end if;
  select r.ref into v_ref from private.owner_sequence_recipients r where r.sequence_id = s.id
    and (private.owner_sequence_blocked(r.email, r.domain, r.ccn) is not null
      or exists (select 1 from private.owner_sequence_recipients x join private.owner_sequences y on y.id = x.sequence_id
        where y.status = 'approved' and x.status = 'active' and (x.email = r.email or (r.ccn is not null and x.ccn = r.ccn)))) limit 1;
  if v_ref is not null then raise exception 'Person % may no longer be emailed; prepare the sequence again', v_ref using errcode = '22023'; end if;
  update private.owner_sequences set status = 'approved', approved_by = v_actor, approved_at = now(), version = version + 1 where id = s.id;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'growth.owner_sequence_approved', 'owner_sequence', s.id, jsonb_build_object('version', p_version));
  return jsonb_build_object('id', s.id, 'version', p_version + 1);
end; $$;

-- Owner: stops one person (p_recipient) or the whole sequence. Emails already sent are not affected.
create or replace function hub.owner_sequence_stop(p_id uuid, p_recipient uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_n integer := 0;
begin
  v_actor := (hub.authorize_app_command() ->> 'user_id')::uuid;
  perform pg_advisory_xact_lock(hashtextextended('owner.sequences', 0));
  if not exists (select 1 from private.owner_sequences where id = p_id and status = 'approved') then
    raise exception 'Only an approved sequence can be stopped' using errcode = '40001';
  end if;
  if p_recipient is not null then
    if not exists (select 1 from private.owner_sequence_recipients where id = p_recipient and sequence_id = p_id) then
      raise exception 'Unknown person' using errcode = 'P0002';
    end if;
    if private.owner_sequence_stop_recipient(p_recipient, 'owner') then v_n := 1; end if;
  else
    update private.owner_sequence_messages m set status = 'cancelled' from private.owner_sequence_recipients r
     where m.recipient_id = r.id and r.sequence_id = p_id and m.status = 'scheduled';
    update private.owner_sequence_recipients set status = 'stopped', stop_reason = 'owner', stopped_at = now(), stop_told = true
     where sequence_id = p_id and status = 'active';
    get diagnostics v_n = row_count;
    update private.owner_sequences set status = 'stopped', stopped_at = now(), version = version + 1 where id = p_id;
  end if;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'growth.owner_sequence_stopped', 'owner_sequence', p_id, jsonb_build_object('people', v_n, 'one', p_recipient is not null));
  return jsonb_build_object('stopped', v_n);
end; $$;

-- Owner: discards a draft.
create or replace function hub.owner_sequence_discard(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_id uuid;
begin
  v_actor := (hub.authorize_app_command() ->> 'user_id')::uuid;
  delete from private.owner_sequences where id = p_id and status = 'draft' returning id into v_id;
  if v_id is null then raise exception 'Only a draft can be discarded' using errcode = '40001'; end if;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'growth.owner_sequence_discarded', 'owner_sequence', v_id, '{}'::jsonb);
  return jsonb_build_object('discarded', true);
end; $$;

-- Owner (the Hub server, while preparing): which of these people may not be emailed, and why.
create or replace function hub.owner_sequence_check(p_people jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
  perform hub.authorize_app_admin();
  if jsonb_typeof(p_people) <> 'array' or jsonb_array_length(p_people) > 200 then raise exception 'Invalid people' using errcode = '22023'; end if;
  return (select coalesce(jsonb_object_agg(x.ref, x.why), '{}'::jsonb) from (
    select p ->> 'ref' as ref, coalesce(private.owner_sequence_blocked(lower(btrim(p ->> 'email')), nullif(lower(p ->> 'domain'), ''), nullif(p ->> 'ccn', '')),
      case when exists (select 1 from private.owner_sequence_recipients r join private.owner_sequences s on s.id = r.sequence_id
        where s.status = 'approved' and r.status = 'active' and (r.email = lower(btrim(p ->> 'email')) or (nullif(p ->> 'ccn', '') is not null and r.ccn = p ->> 'ccn')))
        then 'in_sequence' end,
      case when exists (select 1 from private.growth_messages gm join private.growth_contacts gc on gc.id = gm.contact_id
          join private.growth_organizations g on g.id = gc.organization_id
        where gm.purpose = 'marketing' and gm.attempted_at is not null and gm.attempted_at > now() - interval '90 days'
          and (gc.email = lower(btrim(p ->> 'email')) or (nullif(lower(p ->> 'domain'), '') is not null and g.domain = lower(p ->> 'domain'))))
        then 'growth_contacted' end) as why
    from jsonb_array_elements(p_people) p) x where x.why is not null);
end; $$;

revoke all on function hub.owner_sequences_list(), hub.owner_sequence_detail(uuid), hub.owner_sequence_create(jsonb), hub.owner_sequence_approve(uuid, integer),
  hub.owner_sequence_stop(uuid, uuid), hub.owner_sequence_discard(uuid), hub.owner_sequence_check(jsonb) from public, anon, authenticated, service_role;
grant execute on function hub.owner_sequences_list(), hub.owner_sequence_detail(uuid), hub.owner_sequence_create(jsonb), hub.owner_sequence_approve(uuid, integer),
  hub.owner_sequence_stop(uuid, uuid), hub.owner_sequence_discard(uuid), hub.owner_sequence_check(jsonb) to authenticated, hub_app_server;

-- ---------------------------------------------------------------------------------------
-- Server.
-- ---------------------------------------------------------------------------------------

-- Server: the next due email, claimed for sending ({ send: true, id, to, subject, body, ... }), or why none is ({ send: false, status }).
create or replace function private.owner_sequence_claim() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_local timestamp := now() at time zone 'America/New_York'; v_today date; v_time time; m private.owner_sequence_messages%rowtype;
  r private.owner_sequence_recipients%rowtype; s private.owner_sequences%rowtype; v_blocked text; v_sent integer; v_all integer; v_tries integer := 0;
begin
  perform private.require_hub_app_server();
  perform pg_advisory_xact_lock(hashtextextended('owner.sequences', 0));
  if coalesce((select (h.value #>> '{}')::boolean from private.hub_settings h where h.key = 'growth.owner_sequences'), false) is not true then
    return jsonb_build_object('send', false, 'status', 'off');
  end if;
  v_today := v_local::date; v_time := v_local::time;
  if extract(isodow from v_local) > 5 then return jsonb_build_object('send', false, 'status', 'weekend'); end if;
  -- An email that may have gone out but was never confirmed is settled first.
  update private.owner_sequence_messages set status = 'unknown' where status = 'sending' and attempted_at < now() - interval '10 minutes';
  loop
    v_tries := v_tries + 1;
    if v_tries > 100 then return jsonb_build_object('send', false, 'status', 'none_due'); end if;
    select m1.* into m from private.owner_sequence_messages m1
      join private.owner_sequence_recipients r1 on r1.id = m1.recipient_id
      join private.owner_sequences s1 on s1.id = r1.sequence_id
     where m1.status = 'scheduled' and s1.status = 'approved' and r1.status = 'active' and m1.send_on <= v_today
       and v_time >= s1.window_start and v_time < s1.window_end
       -- Every earlier email to the person went out, on an earlier day, and none is in doubt.
       and not exists (select 1 from private.owner_sequence_messages p where p.recipient_id = r1.id and p.step < m1.step
         and (p.status not in ('accepted', 'delivered') or (p.attempted_at at time zone 'America/New_York')::date >= v_today))
       and not exists (select 1 from private.owner_sequence_messages p where p.recipient_id = r1.id and p.status in ('sending', 'unknown'))
     order by m1.send_on, s1.approved_at, m1.step, r1.ref limit 1 for update of m1;
    if not found then return jsonb_build_object('send', false, 'status', 'none_due'); end if;
    select * into r from private.owner_sequence_recipients where id = m.recipient_id for update;
    select * into s from private.owner_sequences where id = r.sequence_id;
    -- The sequence's own limit, and at most 25 prospecting emails a day in all from the growth sender (the owner's 20 to 30 a mailbox).
    select count(*) into v_sent from private.owner_sequence_messages x join private.owner_sequence_recipients y on y.id = x.recipient_id
     where y.sequence_id = s.id and x.attempted_at >= private.agent_day_start();
    if v_sent >= s.daily_limit then return jsonb_build_object('send', false, 'status', 'daily_limit'); end if;
    select (select count(*) from private.owner_sequence_messages x where x.attempted_at >= private.agent_day_start())
      + (select count(*) from private.growth_messages g where g.purpose = 'marketing' and g.attempted_at >= private.agent_day_start()) into v_all;
    if v_all >= 25 then return jsonb_build_object('send', false, 'status', 'mailbox_limit'); end if;
    -- Never to a forbidden or suppressed address or agency, after a bounce or complaint, or after a reply.
    v_blocked := private.owner_sequence_blocked(r.email, r.domain, r.ccn);
    if v_blocked is not null then perform private.owner_sequence_stop_recipient(r.id, v_blocked); continue; end if;
    if exists (select 1 from private.owner_sequence_messages x where x.recipient_id = r.id and x.status in ('bounced', 'complaint')) then
      perform private.owner_sequence_stop_recipient(r.id, 'bounced'); continue;
    end if;
    if private.owner_sequence_read_replies(r.id) is not null then continue; end if;
    update private.owner_sequence_messages set status = 'sending', attempted_at = now() where id = m.id;
    return jsonb_build_object('send', true, 'id', m.id, 'to', r.email, 'subject', m.subject, 'body', m.body, 'step', m.step,
      'recipientId', r.id, 'sequenceId', s.id, 'unsubscribeHash', r.unsubscribe_hash, 'sender', s.sender);
  end loop;
end; $$;

-- Server: how a claimed email went (accepted, failed or unknown) and the mail service's id.
create or replace function private.owner_sequence_finish(p_id uuid, p_status text, p_provider text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_hub_app_server();
  if p_status not in ('accepted', 'failed', 'unknown') then raise exception 'Invalid outcome' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('owner.sequences', 0));
  update private.owner_sequence_messages set status = p_status, provider_id = left(p_provider, 200) where id = p_id and status = 'sending' returning id into v_id;
  return v_id is not null;
end; $$;

-- Server: the review run. Settles stale sends, reads every active person's replies, finishes sequences with nothing left to send, and
-- returns what the owner has not been told yet: people stopped (and why) and first report opens.
create or replace function private.owner_sequence_review() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_stops jsonb; v_opens jsonb;
begin
  perform private.require_hub_app_server();
  perform pg_advisory_xact_lock(hashtextextended('owner.sequences', 0));
  update private.owner_sequence_messages set status = 'unknown' where status = 'sending' and attempted_at < now() - interval '10 minutes';
  for v_id in select r.id from private.owner_sequence_recipients r join private.owner_sequences s on s.id = r.sequence_id
    where s.status = 'approved' and r.status = 'active'
      and exists (select 1 from private.owner_sequence_messages m where m.recipient_id = r.id and m.attempted_at is not null) loop
    perform private.owner_sequence_read_replies(v_id);
  end loop;
  update private.owner_sequence_recipients r set status = 'finished'
   where r.status = 'active' and not exists (select 1 from private.owner_sequence_messages m where m.recipient_id = r.id and m.status in ('scheduled', 'sending'))
     and exists (select 1 from private.owner_sequences s where s.id = r.sequence_id and s.status = 'approved');
  update private.owner_sequences s set status = 'finished', finished_at = now(), version = version + 1
   where s.status = 'approved' and not exists (select 1 from private.owner_sequence_recipients r where r.sequence_id = s.id and r.status = 'active');
  with told as (update private.owner_sequence_recipients r set stop_told = true where r.status = 'stopped' and not r.stop_told
      and r.stop_reason <> 'owner' returning r.id, r.sequence_id, r.ref, r.agency, r.stop_reason, r.replied_at, r.stopped_at)
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'sequence', s.name, 'ref', t.ref, 'agency', t.agency, 'reason', t.stop_reason,
      'at', coalesce(t.replied_at, t.stopped_at), 'sent', (select count(*) from private.owner_sequence_messages m where m.recipient_id = t.id and m.attempted_at is not null))), '[]'::jsonb)
    into v_stops from told t join private.owner_sequences s on s.id = t.sequence_id;
  with told as (update private.owner_sequence_recipients r set open_told = true where r.first_opened_at is not null and not r.open_told
      returning r.id, r.sequence_id, r.ref, r.agency, r.first_opened_at)
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'sequence', s.name, 'ref', t.ref, 'agency', t.agency, 'at', t.first_opened_at)), '[]'::jsonb)
    into v_opens from told t join private.owner_sequences s on s.id = t.sequence_id;
  return jsonb_build_object('stopped', v_stops, 'opened', v_opens);
end; $$;

-- Server: one delivery event from the mail service, once. A complaint or an unsubscribe forbids the address and the agency for good; a
-- hard bounce suppresses the address; any bounce stops the person's emails.
create or replace function private.owner_sequence_delivery(p_event text, p_message uuid, p_kind text, p_at timestamptz, p_suppress boolean default true) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_recipient uuid; v_email text;
begin
  perform private.require_hub_app_server();
  if p_kind not in ('delivered', 'bounced', 'complaint', 'unsubscribe') then raise exception 'Invalid event' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('owner.sequences', 0));
  select m.recipient_id, r.email into v_recipient, v_email from private.owner_sequence_messages m join private.owner_sequence_recipients r on r.id = m.recipient_id where m.id = p_message;
  if v_recipient is null then return false; end if;
  insert into private.owner_sequence_events(event_id, message_id, kind, occurred_at) values (p_event, p_message, p_kind, p_at) on conflict do nothing;
  if not found then return false; end if;
  if p_kind = 'delivered' then
    update private.owner_sequence_messages set status = 'delivered', delivered_at = p_at where id = p_message and status in ('accepted', 'unknown', 'sending', 'delivered');
  elsif p_kind = 'bounced' then
    update private.owner_sequence_messages set status = 'bounced' where id = p_message;
    perform private.owner_sequence_stop_recipient(v_recipient, 'bounced');
    if coalesce(p_suppress, true) then insert into private.email_suppressions(email_hash) values (private.email_hash(v_email)) on conflict do nothing; end if;
  else
    if p_kind = 'complaint' then update private.owner_sequence_messages set status = 'complaint' where id = p_message; end if;
    perform private.owner_sequence_stop_recipient(v_recipient, case when p_kind = 'complaint' then 'complaint' else 'unsubscribed' end);
    perform private.owner_sequence_forbid(v_recipient, case when p_kind = 'complaint' then 'complaint' else 'unsubscribed' end);
  end if;
  return true;
end; $$;

-- Server: the one-click unsubscribe link of a sequence's email. Returns false for a link that is not a sequence's.
create or replace function private.owner_sequence_unsubscribe(p_hash text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_hub_app_server();
  perform pg_advisory_xact_lock(hashtextextended('owner.sequences', 0));
  select id into v_id from private.owner_sequence_recipients where unsubscribe_hash = p_hash;
  if v_id is null then return false; end if;
  perform private.owner_sequence_stop_recipient(v_id, 'unsubscribed');
  perform private.owner_sequence_forbid(v_id, 'unsubscribed');
  return true;
end; $$;

-- Server: report opens Intel recorded ([{ ref, viewed_at }]) whose reference is a sequence person's. An open counts only once the
-- person's first email had gone out at least two minutes before it (the owner's preview and a mail service's scan come earlier).
create or replace function private.owner_sequence_views(p_views jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_at timestamptz; v_n integer := 0; v_id uuid;
begin
  perform private.require_hub_app_server();
  if jsonb_typeof(p_views) is distinct from 'array' or jsonb_array_length(p_views) > 500 then raise exception 'Invalid page' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('owner.sequences', 0));
  for v in select value from jsonb_array_elements(p_views) loop
    begin v_at := (v ->> 'viewed_at')::timestamptz; exception when others then continue; end;
    if coalesce(v ->> 'ref', '') !~ '^[A-Za-z0-9_-]{1,40}$' or v_at > now() + interval '5 minutes' then continue; end if;
    select r.id into v_id from private.owner_sequence_recipients r join private.owner_sequences s on s.id = r.sequence_id
     where r.ref = v ->> 'ref' and s.status <> 'draft'
       and (select min(m.attempted_at) from private.owner_sequence_messages m where m.recipient_id = r.id) <= v_at - interval '2 minutes'
     order by s.approved_at desc limit 1;
    if v_id is null then continue; end if;
    update private.owner_sequence_recipients set first_opened_at = least(coalesce(first_opened_at, v_at), v_at) where id = v_id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end; $$;

revoke all on function private.owner_sequence_claim(), private.owner_sequence_finish(uuid, text, text), private.owner_sequence_review(),
  private.owner_sequence_delivery(text, uuid, text, timestamptz, boolean), private.owner_sequence_unsubscribe(text), private.owner_sequence_views(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.owner_sequence_claim(), private.owner_sequence_finish(uuid, text, text), private.owner_sequence_review(),
  private.owner_sequence_delivery(text, uuid, text, timestamptz, boolean), private.owner_sequence_unsubscribe(text), private.owner_sequence_views(jsonb)
  to hub_app_server;

-- ---------------------------------------------------------------------------------------
-- The Marketing Manager's own cold email never writes to an organization whose domain said no to a sequence.
-- ---------------------------------------------------------------------------------------
do $$
declare
  d text := pg_get_functiondef('private.growth_outreach_stopped(uuid)'::regprocedure);
  anchor constant text := $q$and exists (select 1 from private.communications m where m.channel = 'email' and lower(btrim(m.contact_email)) = c.email));$q$;
begin
  if position('outreach_do_not_contact' in d) > 0 then return; end if;
  if position(anchor in d) = 0 then raise exception 'growth_outreach_stopped changed; update this migration' using errcode = '55000'; end if;
  execute replace(d, anchor, $q$and exists (select 1 from private.communications m where m.channel = 'email' and lower(btrim(m.contact_email)) = c.email))
  or exists (select 1 from private.growth_organizations g join private.outreach_do_not_contact n on n.kind = 'domain' and n.value = lower(g.domain)
    where g.id = p_org);$q$);
end $$;

-- ---------------------------------------------------------------------------------------
-- The Support Concierge never answers or acknowledges a sequence's person on its own: the reply waits for the owner.
-- ---------------------------------------------------------------------------------------
do $$
declare
  fn text;
  d text;
  anchor constant text := $q$  if v_communication.status = 'closed' then
    return jsonb_build_object('state', 'refused', 'code', 'conversation_closed');
  end if;$q$;
begin
  foreach fn in array array['private.agent_answer_begin(uuid,integer,text[])', 'private.agent_acknowledge_begin(uuid,integer,text[])'] loop
    d := pg_get_functiondef(fn::regprocedure);
    continue when position('owner_sequence' in d) > 0;
    if position(anchor in d) = 0 then raise exception '% changed; update this migration', fn using errcode = '55000'; end if;
    execute replace(d, anchor, anchor || $q$
  -- A person the owner wrote to in one of their own sequences: their reply is the owner's to answer (owner handoff 2026-11-27).
  if v_action.decided_by is null and private.owner_sequence_contact(v_communication.contact_email) then
    return jsonb_build_object('state', 'refused', 'code', 'owner_sequence');
  end if;$q$);
  end loop;
end $$;

insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('marketing_manager', 'growth.sequences', 'interval', 300, null, 'America/New_York', false, now())
on conflict (agent_key, task_kind) do nothing;
