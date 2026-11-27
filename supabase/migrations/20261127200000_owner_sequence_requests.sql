-- Owner sequence requests: the Hub server prepares a send list an operator queued (owner direction 2026-11-27: "you can do that for me").
--
-- Why. Preparing a sequence signs each agency's report link with the Intel feed's secret and each person's unsubscribe link with the growth
-- signing key, both held by the Hub server alone, and saving or approving it needs the owner's current SMS session. An operator working
-- for the owner (CareMetric staff with database access, or Claude Code at the owner's direction) has neither, so the owner had to open
-- Growth themselves. A request is the send list and its choices, queued in the database: the Marketing Manager's growth.sequences task
-- prepares it exactly as the Growth page does (the same checks, matching, links and copy) and saves it in the owner's name; it is approved
-- too when the request says so. The owner is told what was prepared, approved and left out.
--
-- 1. private.owner_sequence_requests: a request (the owner it is for, the send list and choices, whether to approve), closed to every role.
--    Only a database operator inserts one; the Hub server cannot.
-- 2. The draft's save, the people check and the approval move into private functions (owner_sequence_save, owner_sequence_check_people,
--    owner_sequence_approve_as) that the owner's commands and the requests share; the owner's commands still need the owner's session.
-- 3. Server: take the next request (only one for an active CareMetric admin; one a restart left half done is taken again, since its save
--    and its finish are one transaction), check its people, and finish it: saved, approved if asked, or failed with the reason.
--
-- Nothing is sent by this migration. 20261127200100_owner_sequence_requests_contract.sql declares platform.agents.owner-sequence-requests.v1.
set local lock_timeout = '10s';

create table if not exists private.owner_sequence_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references auth.users(id),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 100000),
  approve boolean not null default false,
  status text not null default 'waiting' check (status in ('waiting', 'preparing', 'prepared', 'failed')),
  sequence_id uuid references private.owner_sequences(id) on delete set null,
  result jsonb not null default '{}' check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz
);
alter table private.owner_sequence_requests enable row level security;
revoke all on private.owner_sequence_requests from public, anon, authenticated, service_role, hub_app_server;

-- ---------------------------------------------------------------------------------------
-- The draft's save, the people check and the approval, shared by the owner's commands and the requests (no role may run them directly).
-- ---------------------------------------------------------------------------------------

create or replace function private.owner_sequence_save(p_actor uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_recipient uuid; v_dates date[]; v_today date := (now() at time zone 'America/New_York')::date;
  p jsonb; m jsonb; v_email text; v_domain text; v_ccn text; v_blocked text; i integer;
begin
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
    coalesce((p_data ->> 'windowEnd')::time, '11:00'), coalesce((p_data ->> 'dailyLimit')::integer, 8), coalesce(p_data -> 'sender', '{}'::jsonb), p_actor)
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
  values (p_actor, 'growth.owner_sequence_saved', 'owner_sequence', v_id, jsonb_build_object('people', jsonb_array_length(p_data -> 'people'),
    'emails', cardinality(v_dates), 'template', p_data ->> 'template'));
  return jsonb_build_object('id', v_id, 'version', 1);
end; $$;

create or replace function private.owner_sequence_check_people(p_people jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
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

create or replace function private.owner_sequence_approve_as(p_actor uuid, p_id uuid, p_version integer, p_via text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s private.owner_sequences%rowtype; v_ref text;
begin
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
  update private.owner_sequences set status = 'approved', approved_by = p_actor, approved_at = now(), version = version + 1 where id = s.id;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (p_actor, 'growth.owner_sequence_approved', 'owner_sequence', s.id, jsonb_build_object('version', p_version, 'via', p_via));
  return jsonb_build_object('id', s.id, 'version', p_version + 1);
end; $$;

revoke all on function private.owner_sequence_save(uuid, jsonb), private.owner_sequence_check_people(jsonb), private.owner_sequence_approve_as(uuid, uuid, integer, text)
  from public, anon, authenticated, service_role, hub_app_server;

-- The owner's commands: the same as 20261127150000, delegating to the shared functions. Each still needs the owner's session.
create or replace function hub.owner_sequence_create(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;
begin
  v_actor := (hub.authorize_app_command() ->> 'user_id')::uuid;
  return private.owner_sequence_save(v_actor, p_data);
end; $$;

create or replace function hub.owner_sequence_approve(p_id uuid, p_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;
begin
  v_actor := (hub.authorize_app_command() ->> 'user_id')::uuid;
  return private.owner_sequence_approve_as(v_actor, p_id, p_version, 'owner');
end; $$;

create or replace function hub.owner_sequence_check(p_people jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
  perform hub.authorize_app_admin();
  return private.owner_sequence_check_people(p_people);
end; $$;

revoke all on function hub.owner_sequence_create(jsonb), hub.owner_sequence_approve(uuid, integer), hub.owner_sequence_check(jsonb) from public, anon, authenticated, service_role;
grant execute on function hub.owner_sequence_create(jsonb), hub.owner_sequence_approve(uuid, integer), hub.owner_sequence_check(jsonb) to authenticated, hub_app_server;

-- ---------------------------------------------------------------------------------------
-- Server: the requests.
-- ---------------------------------------------------------------------------------------

-- Server: the next request ({ id, payload, approve }), now being prepared, or null. Only a request for an active CareMetric admin is
-- prepared; any other fails. One a restart left half done is taken up again: its save and its finish are one transaction.
create or replace function private.owner_sequence_request_next() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r private.owner_sequence_requests%rowtype;
begin
  perform private.require_hub_app_server();
  perform pg_advisory_xact_lock(hashtextextended('owner.sequences', 0));
  update private.owner_sequence_requests set status = 'waiting', claimed_at = null where status = 'preparing' and claimed_at < now() - interval '15 minutes';
  loop
    select * into r from private.owner_sequence_requests where status = 'waiting' order by created_at, id limit 1 for update;
    if not found then return null; end if;
    if exists (select 1 from private.staff_permissions p where p.user_id = r.requested_by and p.permission = 'platform.admin'
        and p.product_id is null and p.revoked_at is null) then
      update private.owner_sequence_requests set status = 'preparing', claimed_at = now() where id = r.id;
      return jsonb_build_object('id', r.id, 'payload', r.payload, 'approve', r.approve);
    end if;
    update private.owner_sequence_requests set status = 'failed', finished_at = now(), result = jsonb_build_object('error', 'not_an_admin') where id = r.id;
  end loop;
end; $$;

-- Server: which of a request's people may not be emailed, and why (only while the request is being prepared).
create or replace function private.owner_sequence_request_check(p_request uuid, p_people jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
  perform private.require_hub_app_server();
  if not exists (select 1 from private.owner_sequence_requests where id = p_request and status = 'preparing') then
    raise exception 'That request is not being prepared' using errcode = '42501';
  end if;
  return private.owner_sequence_check_people(p_people);
end; $$;

-- Server: finishes a request. With a record, the draft is saved in the requester's name and approved if the request asked; a draft the
-- database refuses (a person who may not be emailed, a date that passed) fails the request with the reason. Without one, it fails.
create or replace function private.owner_sequence_request_finish(p_request uuid, p_record jsonb, p_problems jsonb, p_error text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r private.owner_sequence_requests%rowtype; v_saved jsonb; v_approved boolean := false; v_problems jsonb := coalesce(p_problems, '[]'::jsonb);
begin
  perform private.require_hub_app_server();
  perform pg_advisory_xact_lock(hashtextextended('owner.sequences', 0));
  select * into r from private.owner_sequence_requests where id = p_request for update;
  if not found or r.status <> 'preparing' then raise exception 'Refresh this request' using errcode = '40001'; end if;
  if jsonb_typeof(v_problems) <> 'array' or jsonb_array_length(v_problems) > 200 then raise exception 'Invalid problems' using errcode = '22023'; end if;
  if p_record is null then
    update private.owner_sequence_requests set status = 'failed', finished_at = now(),
      result = jsonb_build_object('problems', v_problems, 'error', left(coalesce(p_error, 'nothing_prepared'), 300)) where id = r.id;
    return jsonb_build_object('status', 'failed', 'error', left(coalesce(p_error, 'nothing_prepared'), 300));
  end if;
  begin
    v_saved := private.owner_sequence_save(r.requested_by, p_record);
    if r.approve then
      perform private.owner_sequence_approve_as(r.requested_by, (v_saved ->> 'id')::uuid, (v_saved ->> 'version')::integer, 'request');
      v_approved := true;
    end if;
  exception when others then
    update private.owner_sequence_requests set status = 'failed', finished_at = now(),
      result = jsonb_build_object('problems', v_problems, 'error', left(sqlerrm, 300)) where id = r.id;
    return jsonb_build_object('status', 'failed', 'error', left(sqlerrm, 300));
  end;
  update private.owner_sequence_requests set status = 'prepared', finished_at = now(), sequence_id = (v_saved ->> 'id')::uuid,
    result = jsonb_build_object('problems', v_problems, 'approved', v_approved, 'people', jsonb_array_length(p_record -> 'people')) where id = r.id;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (r.requested_by, 'growth.owner_sequence_request', 'owner_sequence', (v_saved ->> 'id')::uuid,
    jsonb_build_object('request', r.id, 'approved', v_approved, 'people', jsonb_array_length(p_record -> 'people'), 'leftOut', jsonb_array_length(v_problems)));
  return jsonb_build_object('status', 'prepared', 'sequenceId', v_saved ->> 'id', 'approved', v_approved);
end; $$;

revoke all on function private.owner_sequence_request_next(), private.owner_sequence_request_check(uuid, jsonb),
  private.owner_sequence_request_finish(uuid, jsonb, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function private.owner_sequence_request_next(), private.owner_sequence_request_check(uuid, jsonb),
  private.owner_sequence_request_finish(uuid, jsonb, jsonb, text) to hub_app_server;
