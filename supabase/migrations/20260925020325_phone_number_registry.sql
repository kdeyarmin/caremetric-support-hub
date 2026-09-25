-- Business phone inventory only. Never stores callers, recordings or credentials.
create table private.phone_numbers (
  id uuid primary key default gen_random_uuid(),
  number text not null unique check (number ~ '^\+[1-9][0-9]{7,14}$'),
  record jsonb not null check (jsonb_typeof(record)='object'),
  version integer not null default 1 check (version>0),
  updated_at timestamptz not null default now()
);
alter table private.phone_numbers enable row level security;
revoke all on private.phone_numbers from public,anon,authenticated,hub_app_server;
comment on table private.phone_numbers is 'Administrator-maintained phone inventory; dated observations, not live provider monitoring.';

create function hub.list_phone_numbers() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform hub.authorize_app_admin();
  select coalesce(jsonb_agg(record || jsonb_build_object('id',id,'version',version,'updated_at',updated_at) order by number),'[]'::jsonb) into result
  from private.phone_numbers;
  return jsonb_build_object('rows',result,'loaded_at',now());
end;
$$;

create function hub.save_phone_number(p_id uuid,p_record jsonb,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare saved private.phone_numbers; old private.phone_numbers; field record; date_key text;
begin
  perform hub.authorize_app_admin();
  if p_record is null or jsonb_typeof(p_record)<>'object'
    or (select count(*) from jsonb_object_keys(p_record))<>17
    or not p_record ?& array['number','label','provider','account','purpose','apps','owner','lifecycle','usage_status','voice_status','voice_routing','sms_status','sms_routing','last_used_on','reviewed_on','evidence','notes'] then
    raise exception 'Invalid phone record.';
  end if;
  for field in select * from jsonb_each(p_record) loop
    if jsonb_typeof(field.value)<>'string' or length(field.value#>>'{}') > (case field.key
      when 'number' then 16
      when 'label' then 100
      when 'provider' then 100
      when 'account' then 100
      when 'purpose' then 500
      when 'apps' then 300
      when 'owner' then 100
      when 'lifecycle' then 20
      when 'usage_status' then 30
      when 'voice_status' then 30
      when 'voice_routing' then 500
      when 'sms_status' then 30
      when 'sms_routing' then 500
      when 'last_used_on' then 10
      when 'reviewed_on' then 10
      when 'evidence' then 1000
      when 'notes' then 2000
      else 0 end) or (field.value#>>'{}') ~ '[[:cntrl:]]' then
      raise exception 'Invalid phone field.';
    end if;
  end loop;
  if p_record->>'number' !~ '^\+[1-9][0-9]{7,14}$'
    or btrim(p_record->>'label')='' or btrim(p_record->>'provider')='' or btrim(p_record->>'purpose')=''
    or p_record->>'lifecycle' not in ('active','reserved','retired','unknown')
    or p_record->>'usage_status' not in ('observed','no_activity_observed','unknown')
    or p_record->>'voice_status' not in ('configured','not_configured','unknown')
    or p_record->>'sms_status' not in ('configured','pending','rejected','disabled','unknown') then
    raise exception 'Invalid phone details.';
  end if;
  foreach date_key in array array['last_used_on','reviewed_on'] loop
    if p_record->>date_key <> '' and (
      p_record->>date_key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or (p_record->>date_key)::date > current_date) then raise exception 'Invalid observation date.'; end if;
  end loop;
  if p_record->>'usage_status'<>'unknown' and (btrim(p_record->>'evidence')='' or p_record->>'reviewed_on'='') then
    raise exception 'Usage observations require dated evidence.';
  end if;
  if p_id is null then
    if p_expected_version is distinct from 0 then raise exception 'Invalid new record version.'; end if;
    insert into private.phone_numbers(number,record) values(p_record->>'number',p_record) returning * into saved;
  else
    select * into old from private.phone_numbers where id=p_id for update;
    if not found or old.version is distinct from p_expected_version then raise exception 'Record changed. Refresh and review before saving.'; end if;
    if old.number<>p_record->>'number' then raise exception 'Number cannot be changed. Add another number instead.'; end if;
    update private.phone_numbers set record=p_record,version=version+1,updated_at=clock_timestamp() where id=p_id returning * into saved;
  end if;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(auth.uid(),case when p_id is null then 'phone_registry.add' else 'phone_registry.update' end,'phone_number',saved.id,jsonb_build_object('version',saved.version));
  return saved.record || jsonb_build_object('id',saved.id,'version',saved.version,'updated_at',saved.updated_at);
end;
$$;
revoke all on function hub.list_phone_numbers(),hub.save_phone_number(uuid,jsonb,integer) from public,anon;
grant execute on function hub.list_phone_numbers(),hub.save_phone_number(uuid,jsonb,integer) to authenticated;

-- Only the four numbers actually observed in the signed-in account are seeded.
insert into private.phone_numbers(number,record) values('+18775212890','{"provider":"Twilio","account":"CareMetric AI","owner":"","lifecycle":"active","usage_status":"observed","voice_status":"configured","sms_status":"pending","last_used_on":"","reviewed_on":"2026-09-24","evidence":"Twilio showed a completed voice call returning HTTP 200 and opening the voice stream during the September 24 audit. No outgoing SMS records were shown in the available log view; this does not establish historical nonuse.","notes":"Shared business assistant deployed. Requested link texts are disabled pending replacement SMS verification approval. Existing approval describes patient reminders/2FA with web-form consent. Replacement authorized but awaiting Twilio browser sign-in.","voice_routing":"https://cmbreathe.com/resupply-api/voice/inbound-breathe-sales","sms_routing":"CareMetric AI service; inbound POST https://cmbreathe.com/resupply-api/sms/caremetric-inbound","number":"+18775212890","label":"CareMetric shared support and Advisors","purpose":"Software technical support, customer service, and Healthcare Advisors reception.","apps":"All CareMetric software; CareMetric Healthcare Advisors"}'::jsonb);
insert into private.phone_numbers(number,record) values('+18333489271','{"provider":"Twilio","account":"CareMetric AI","owner":"","lifecycle":"active","usage_status":"unknown","voice_status":"configured","sms_status":"rejected","last_used_on":"","reviewed_on":"2026-09-24","evidence":"Twilio Console configuration inspected September 24, 2026. Configuration alone does not prove recent traffic.","notes":"Twilio showed rejected toll-free SMS verification. Keep separate from software support. Actual recent call/text usage has not been verified.","voice_routing":"https://pennpaps.com/resupply-api/voice/inbound-reorder","sms_routing":"","number":"+18333489271","label":"PennPaps patient reorder — 833","purpose":"Patient supply reordering.","apps":"PennPaps patient operations"}'::jsonb);
insert into private.phone_numbers(number,record) values('+18559542809','{"provider":"Twilio","account":"CareMetric AI","owner":"","lifecycle":"active","usage_status":"unknown","voice_status":"configured","sms_status":"unknown","last_used_on":"","reviewed_on":"2026-09-24","evidence":"Twilio Console configuration inspected September 24, 2026. Configuration alone does not prove recent traffic.","notes":"Do not consolidate with the shared software-support line without checking patient workflows. SMS approval and actual traffic still need review.","voice_routing":"https://pennpaps.com/resupply-api/voice/inbound-reorder","sms_routing":"Separate marketing messaging service (observed in Twilio).","number":"+18559542809","label":"PennPaps patient reorder — 855","purpose":"Patient supply reordering; separate messaging service.","apps":"PennPaps patient operations"}'::jsonb);
insert into private.phone_numbers(number,record) values('+18149169606','{"provider":"Twilio","account":"CareMetric AI","owner":"","lifecycle":"active","usage_status":"unknown","voice_status":"configured","sms_status":"configured","last_used_on":"","reviewed_on":"2026-09-24","evidence":"Twilio Console configuration inspected September 24, 2026. Configuration alone does not prove recent traffic.","notes":"Preserve patient operations. Actual recent call/text usage has not been verified.","voice_routing":"https://pennpaps.com/resupply-api/voice/inbound-reorder","sms_routing":"Patient SMS Customer Care A2P Messaging Service.","number":"+18149169606","label":"PennPaps patient voice and SMS","purpose":"Patient supply reordering and patient SMS.","apps":"PennPaps patient operations"}'::jsonb);
