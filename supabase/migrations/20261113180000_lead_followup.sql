-- Website leads that were only counted get a follow-up (review 2026-11-12, finding P1: inbound leads are never followed up).
--
-- private.lead_record opened a conversation in Communications only for a demo request, a consultation or a contact form. A
-- county report request, a savings model, a newsletter sign-up or a trial sign-up was recorded and counted (the Leads screen,
-- the daily digest), and nobody wrote back: the warmest people the company hears from got no email.
--
-- Now every such lead that is not a test opens the same kind of web_form conversation (inquiry type sales; the source's own
-- website as its source; keyed by the externalId), with a subject that names what the visitor did ("County report request: ",
-- "Savings model: ", "Newsletter sign-up: ", "Trial sign-up: ") and an inbound message that starts with one plain line saying
-- so ("Requested the free county report.") followed, as before, by anything the visitor wrote and the facts as Label: value
-- lines. The Support Concierge alerts on it and hands it to the Sales Executive (private.sales_handoff already takes any
-- CareBase or Intel website conversation), which writes a short personal follow-up with the product's own pages and the free
-- trial as the next step, under the same checks and the same "Sales answers" autonomy step as a demo request's answer.
--
-- private.lead_record is replaced with the same signature and grants and the same body otherwise. The response to the product
-- now names a conversation for these kinds too. Leads already recorded are left as they are: production's were tests from
-- CareMetric's own addresses. No table, grant or declared feature changes.
set local lock_timeout = '10s';

create or replace function private.lead_record(p_source text, p_lead jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_kind text;
  v_external text;
  v_test boolean;
  v_occurred timestamptz;
  v_contact jsonb;
  v_email text;
  v_name text;
  v_phone text;
  v_organization text;
  v_role text;
  v_details jsonb;
  v_message text;
  v_attribution jsonb;
  v_utm_source text;
  v_utm_medium text;
  v_utm_campaign text;
  v_utm_term text;
  v_utm_content text;
  v_referrer text;
  v_landing text;
  v_first_seen timestamptz;
  v_product uuid;
  v_id uuid;
  v_conversation uuid;
  v_reference bigint;
  v_system text;
  v_at timestamptz;
  v_lines text;
  v_body text;
  v_opening text;
begin
  -- The envelope: known keys only, the required ones present, each of the right type.
  if p_source is null or p_source not in ('carebase','intel','advisors')
    or p_lead is null or jsonb_typeof(p_lead) <> 'object'
    or exists (select 1 from jsonb_object_keys(p_lead) k
      where k not in ('version','source','kind','externalId','occurredAt','test','contact','details','message','attribution'))
    or not (p_lead ?& array['version','source','kind','externalId','occurredAt','contact'])
    or (p_lead -> 'version') is distinct from '1'::jsonb
    or (p_lead -> 'source') is distinct from to_jsonb(p_source)
    or jsonb_typeof(p_lead -> 'kind') is distinct from 'string'
    or (p_lead ->> 'kind') not in ('demo_request','consultation','contact','trial_signup','newsletter','savings_model','county_report')
    or jsonb_typeof(p_lead -> 'externalId') is distinct from 'string'
    or (p_lead ->> 'externalId') !~ '^[A-Za-z0-9._:-]{1,100}$'
    or coalesce(jsonb_typeof(p_lead -> 'test'), 'null') not in ('boolean','null')
    or jsonb_typeof(p_lead -> 'contact') is distinct from 'object'
    or coalesce(jsonb_typeof(p_lead -> 'details'), 'null') not in ('object','null')
    or coalesce(jsonb_typeof(p_lead -> 'message'), 'null') not in ('string','null')
    or coalesce(jsonb_typeof(p_lead -> 'attribution'), 'null') not in ('object','null') then
    raise exception 'Invalid lead.' using errcode = '22023';
  end if;
  v_kind := p_lead ->> 'kind';
  v_external := p_lead ->> 'externalId';
  v_test := coalesce(jsonb_typeof(p_lead -> 'test') = 'boolean' and (p_lead -> 'test') = 'true'::jsonb, false);
  v_occurred := private.lead_instant(p_lead -> 'occurredAt');
  if v_occurred is null or v_occurred > now() + interval '5 minutes'
    -- Advisors forwards its inquiry reference; only a probe (a test lead) uses another id.
    or (p_source = 'advisors' and not v_test and v_external !~ '^CM-[A-F0-9]{12}$') then
    raise exception 'Invalid lead.' using errcode = '22023';
  end if;

  -- The contact: an address is required, every other field is an optional short string.
  v_contact := p_lead -> 'contact';
  if exists (select 1 from jsonb_object_keys(v_contact) k where k not in ('name','email','phone','organization','role'))
    or jsonb_typeof(v_contact -> 'email') is distinct from 'string'
    or char_length(v_contact ->> 'email') > 320 then
    raise exception 'Invalid lead.' using errcode = '22023';
  end if;
  -- An address and nothing else: letters, digits and . _ ' + - in dot-separated parts before one @, and dot-separated
  -- labels of letters, digits and hyphens after it. Characters that mean something in a URL or a mailto: link
  -- (? & # % / \ , ; : = and the like), spaces and anything else are refused, so a stored address can never carry mail
  -- headers or another recipient.
  v_email := lower(btrim(v_contact ->> 'email'));
  if char_length(v_email) < 3 or v_email !~ '^[a-z0-9_''+-]+(\.[a-z0-9_''+-]+)*@[a-z0-9-]+(\.[a-z0-9-]+)+$' then
    raise exception 'Invalid lead.' using errcode = '22023';
  end if;
  v_name := private.lead_text(v_contact -> 'name', 200);
  v_phone := private.lead_text(v_contact -> 'phone', 40);
  v_organization := private.lead_text(v_contact -> 'organization', 200);
  v_role := private.lead_text(v_contact -> 'role', 100);

  -- Details: at most 12 flat facts. A string is kept on one line; an empty one is dropped.
  v_details := coalesce(nullif(p_lead -> 'details', 'null'::jsonb), '{}'::jsonb);
  if (select count(*) from jsonb_object_keys(v_details)) > 12
    or exists (select 1 from jsonb_each(v_details) e
      where e.key !~ '^[a-zA-Z][a-zA-Z0-9]{0,39}$'
        or jsonb_typeof(e.value) not in ('string','number','boolean')
        or (jsonb_typeof(e.value) = 'string' and char_length(e.value #>> '{}') > 200)) then
    raise exception 'Invalid lead.' using errcode = '22023';
  end if;
  select coalesce(jsonb_object_agg(f.key, f.value), '{}'::jsonb) into v_details
  from (
    select e.key, case when jsonb_typeof(e.value) = 'string' then to_jsonb(private.communication_line(e.value #>> '{}', 200)) else e.value end as value
    from jsonb_each(v_details) e
  ) f
  where f.value is not null;

  -- The message: possibly PHI. It goes only into the conversation below and is never stored on the lead.
  if jsonb_typeof(p_lead -> 'message') = 'string' then
    if char_length(p_lead ->> 'message') > 4000 then
      raise exception 'Invalid lead.' using errcode = '22023';
    end if;
    v_message := private.communication_body(p_lead ->> 'message');
  end if;

  -- First-touch attribution: every field optional; a host name only and a path only.
  v_attribution := coalesce(nullif(p_lead -> 'attribution', 'null'::jsonb), '{}'::jsonb);
  if exists (select 1 from jsonb_object_keys(v_attribution) k
    where k not in ('utmSource','utmMedium','utmCampaign','utmTerm','utmContent','referrerHost','landingPath','firstSeenAt')) then
    raise exception 'Invalid lead.' using errcode = '22023';
  end if;
  v_utm_source := private.lead_text(v_attribution -> 'utmSource', 200);
  v_utm_medium := private.lead_text(v_attribution -> 'utmMedium', 200);
  v_utm_campaign := private.lead_text(v_attribution -> 'utmCampaign', 200);
  v_utm_term := private.lead_text(v_attribution -> 'utmTerm', 200);
  v_utm_content := private.lead_text(v_attribution -> 'utmContent', 200);
  v_referrer := lower(private.lead_text(v_attribution -> 'referrerHost', 200));
  v_landing := private.lead_text(v_attribution -> 'landingPath', 300);
  if coalesce(jsonb_typeof(v_attribution -> 'firstSeenAt'), 'null') <> 'null' then
    v_first_seen := private.lead_instant(v_attribution -> 'firstSeenAt');
    if v_first_seen is null then
      raise exception 'Invalid lead.' using errcode = '22023';
    end if;
  end if;
  if v_referrer !~ '^[a-z0-9._-]+$' or v_landing !~ '^/[^?#[:space:][:cntrl:]]*$' then
    raise exception 'Invalid lead.' using errcode = '22023';
  end if;

  -- Recorded once per (source, externalId). A repeat changes nothing and is answered as a duplicate.
  v_product := private.communication_product(p_source);
  insert into private.leads (source, kind, external_id, test, occurred_at, contact_name, contact_email, contact_phone, organization, role,
    details, utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer_host, landing_path, first_seen_at, product_id)
  values (p_source, v_kind, v_external, v_test, v_occurred, v_name, v_email, v_phone, v_organization, v_role,
    v_details, v_utm_source, v_utm_medium, v_utm_campaign, v_utm_term, v_utm_content, v_referrer, v_landing, v_first_seen, v_product)
  on conflict (source, external_id) do nothing
  returning id into v_id;
  if v_id is null then
    select l.id, c.reference into v_id, v_reference
    from private.leads l left join private.communications c on c.id = l.communication_id
    where l.source = p_source and l.external_id = v_external;
    if v_id is null then
      -- The row the conflict named is gone again: let the product retry.
      raise exception 'Lead intake conflicted. Try again.' using errcode = '40001';
    end if;
    return jsonb_build_object('id', v_id, 'duplicate', true, 'conversation', case when v_reference is null then null else 'CM-' || v_reference end);
  end if;

  -- A person who asked to be contacted, or who asked for a report, a savings model, the newsletter or a trial, gets a
  -- conversation in Communications, so the Sales Executive follows up. A probe never does.
  if not v_test and v_kind in ('demo_request','consultation','contact','county_report','savings_model','newsletter','trial_signup') then
    v_system := p_source || '.web';
    v_at := least(v_occurred, now());
    v_lines := concat_ws(E'\n',
      case when v_role is not null then 'Role: ' || v_role end,
      (select string_agg(upper(left(x.label, 1)) || substr(x.label, 2) || ': ' ||
          case jsonb_typeof(e.value) when 'boolean' then case when e.value = 'true'::jsonb then 'Yes' else 'No' end else e.value #>> '{}' end,
          E'\n' order by e.key)
        from jsonb_each(v_details) e
        cross join lateral (select lower(regexp_replace(e.key, '([a-z0-9])([A-Z])', '\1 \2', 'g')) as label) x));
    -- What the visitor did, for the kinds that are not a written request: the follow-up answers that.
    v_opening := case v_kind when 'county_report' then 'Requested the free county report.' when 'savings_model' then 'Used the savings model.'
      when 'newsletter' then 'Signed up for the newsletter.' when 'trial_signup' then 'Started a free trial.' end;
    v_body := coalesce(private.communication_body(concat_ws(E'\n\n', v_opening, v_message, nullif(v_lines, ''))),
      'No message was included with this request.');
    -- Advisors: a consultation the owner already imported with "Import Advisors requests" is linked, not copied.
    insert into private.communications (channel, source_system, source_key, status, product_id, inquiry_type, subject,
      contact_name, contact_email, contact_phone, organization, created_at, updated_at, last_message_at)
    values ('web_form', v_system, v_external, 'new', v_product, case when v_kind = 'consultation' then 'advisors' else 'sales' end,
      private.communication_line(case v_kind when 'demo_request' then 'Demo request: ' when 'consultation' then 'Consultation request: '
        when 'county_report' then 'County report request: ' when 'savings_model' then 'Savings model: '
        when 'newsletter' then 'Newsletter sign-up: ' when 'trial_signup' then 'Trial sign-up: '
        else 'Contact request: ' end || coalesce(v_organization, v_name, v_email), 200),
      private.communication_line(v_name, 160), v_email, v_phone, v_organization, v_at, now(), v_at)
    on conflict (source_system, source_key) do nothing
    returning id, reference into v_conversation, v_reference;
    if v_conversation is null then
      select c.id, c.reference into v_conversation, v_reference
      from private.communications c where c.source_system = v_system and c.source_key = v_external;
    else
      insert into private.communication_messages (communication_id, direction, body, delivery, provider_message_id, created_at)
      values (v_conversation, 'inbound', v_body, 'received', v_system || ':' || v_external, v_at);
    end if;
    update private.leads set communication_id = v_conversation where id = v_id;
  end if;

  -- Metadata only: never the contact or what the visitor wrote.
  insert into private.audit_events (actor_id, action, entity_type, entity_id, product_id, metadata)
  values (null, 'lead.received', 'lead', v_id, v_product, jsonb_build_object('source', p_source, 'kind', v_kind, 'test', v_test));
  return jsonb_build_object('id', v_id, 'duplicate', false, 'conversation', case when v_reference is null then null else 'CM-' || v_reference end);
end;
$$;
revoke all on function private.lead_record(text, jsonb) from public, anon, authenticated, service_role, hub_app_server;

do $$
begin
  if not exists (select 1 from pg_proc where oid = 'private.lead_record(text,jsonb)'::regprocedure
                   and proconfig @> array['search_path=""'] and prosrc like '%''county_report'',''savings_model'',''newsletter'',''trial_signup''%')
     or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
                where has_function_privilege(r, 'private.lead_record(text,jsonb)', 'execute')) then
    raise exception 'Website leads are not all followed up' using errcode = '55000';
  end if;
end $$;
