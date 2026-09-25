-- Extend the super-admin inventory; never stores credentials or changes provider routing.
create or replace function hub.list_phone_numbers() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform hub.authorize_app_admin();
  select coalesce(jsonb_agg('{"tenant":"","account_type":"unknown","account_sid":"","parent_account_sid":"","business_profile_status":"unknown","messaging_registration":"","migration_status":"unknown"}'::jsonb || record || jsonb_build_object('id',id,'version',version,'updated_at',updated_at) order by number),'[]'::jsonb) into result
  from private.phone_numbers;
  return jsonb_build_object('rows',result,'loaded_at',now());
end;
$$;

create or replace function hub.save_phone_number(p_id uuid,p_record jsonb,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare saved private.phone_numbers; old private.phone_numbers; field record; date_key text;
begin
  perform hub.authorize_app_admin();
  if p_record is null or jsonb_typeof(p_record)<>'object'
    or (select count(*) from jsonb_object_keys(p_record)) not between 17 and 24
    or not p_record ?& array['number','label','provider','account','purpose','apps','owner','lifecycle','usage_status','voice_status','voice_routing','sms_status','sms_routing','last_used_on','reviewed_on','evidence','notes'] then
    raise exception 'Invalid phone record.';
  end if;
  for field in select * from jsonb_each(p_record) loop
    if field.key not in ('number','label','provider','account','purpose','apps','owner','lifecycle','usage_status','voice_status','voice_routing','sms_status','sms_routing','last_used_on','reviewed_on','evidence','notes','tenant','account_type','account_sid','parent_account_sid','business_profile_status','messaging_registration','migration_status') or jsonb_typeof(field.value)<>'string' or length(field.value#>>'{}') > (case field.key
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
      when 'tenant' then 200
      when 'account_type' then 30
      when 'account_sid' then 34
      when 'parent_account_sid' then 34
      when 'business_profile_status' then 30
      when 'messaging_registration' then 300
      when 'migration_status' then 30
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
  if coalesce(p_record->>'account_type','unknown') not in ('parent','subaccount','tenant_owned','shared','unknown')
    or coalesce(p_record->>'business_profile_status','unknown') not in ('unknown','draft','pending','approved','rejected')
    or coalesce(p_record->>'migration_status','unknown') not in ('unknown','planned','staged','active')
    or (coalesce(p_record->>'account_sid','')<>'' and p_record->>'account_sid' !~ '^AC[0-9a-fA-F]{32}$')
    or (coalesce(p_record->>'parent_account_sid','')<>'' and p_record->>'parent_account_sid' !~ '^AC[0-9a-fA-F]{32}$') then
    raise exception 'Invalid phone account details.';
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
    p_record := '{"tenant":"","account_type":"unknown","account_sid":"","parent_account_sid":"","business_profile_status":"unknown","messaging_registration":"","migration_status":"unknown"}'::jsonb || p_record;
    insert into private.phone_numbers(number,record) values(p_record->>'number',p_record) returning * into saved;
  else
    select * into old from private.phone_numbers where id=p_id for update;
    if not found or old.version is distinct from p_expected_version then raise exception 'Record changed. Refresh and review before saving.'; end if;
    if old.number<>p_record->>'number' then raise exception 'Number cannot be changed. Add another number instead.'; end if;
    p_record := '{"tenant":"","account_type":"unknown","account_sid":"","parent_account_sid":"","business_profile_status":"unknown","messaging_registration":"","migration_status":"unknown"}'::jsonb || old.record || p_record;
    update private.phone_numbers set record=p_record,version=version+1,updated_at=clock_timestamp() where id=p_id returning * into saved;
  end if;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(auth.uid(),case when p_id is null then 'phone_registry.add' else 'phone_registry.update' end,'phone_number',saved.id,jsonb_build_object('version',saved.version));
  return saved.record || jsonb_build_object('id',saved.id,'version',saved.version,'updated_at',saved.updated_at);
end;
$$;
revoke all on function hub.list_phone_numbers(),hub.save_phone_number(uuid,jsonb,integer) from public,anon;
grant execute on function hub.list_phone_numbers(),hub.save_phone_number(uuid,jsonb,integer) to authenticated;


-- Existing numbers retain their observed account. Planned migration is not activation.
with updated as (
  update private.phone_numbers set record=record || jsonb_build_object(
    'tenant',case when number='+18775212890' then 'CareMetric' else 'Penn Home Medical Supply' end,
    'account_type','shared','account_sid','ACe9ff747824552f4b3d8bad19e29e8337',
    'parent_account_sid','','business_profile_status','unknown','messaging_registration','',
    'migration_status',case when number='+18775212890' then 'unknown' else 'planned' end),
    version=version+1,updated_at=clock_timestamp()
  where number in ('+18775212890','+18333489271','+18559542809','+18149169606') and not record ? 'account_type'
  returning id,version
) insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
  select null,'phone_registry.account_inventory','phone_number',id,jsonb_build_object('version',version) from updated;

-- Additive deployment gate for the private phone inventory.
do $$ declare contract jsonb:=hub.get_backend_contract(); signature text; begin
  if (contract @> '{"api_version":4,"features":["app.sms.v1","platform.admin.read.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub SMS and administrator foundations first' using errcode='55000';
  end if;
  if to_regclass('private.phone_numbers') is null or to_regprocedure('hub.list_phone_numbers()') is null
    or to_regprocedure('hub.save_phone_number(uuid,jsonb,integer)') is null
    or to_regprocedure('hub.authorize_app_admin()') is null then
    raise exception 'Apply the phone registry and administrator authorization first' using errcode='55000';
  end if;
  if not (select relrowsecurity from pg_class where oid='private.phone_numbers'::regclass)
    or has_table_privilege('authenticated','private.phone_numbers','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('anon','private.phone_numbers','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('hub_app_server','private.phone_numbers','SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'Private phone registry access must remain closed' using errcode='55000';
  end if;
  foreach signature in array array['hub.list_phone_numbers()','hub.save_phone_number(uuid,jsonb,integer)'] loop
    if has_function_privilege('anon',signature,'EXECUTE')
      or not has_function_privilege('authenticated',signature,'EXECUTE')
      or position('hub.authorize_app_admin()' in pg_get_functiondef(signature::regprocedure))=0 then
      raise exception 'Phone registry RPCs require current administrator authorization' using errcode='55000';
    end if;
  end loop;
  if position('parent_account_sid' in pg_get_functiondef('hub.save_phone_number(uuid,jsonb,integer)'::regprocedure))=0
    or position('migration_status' in pg_get_functiondef('hub.list_phone_numbers()'::regprocedure))=0 then
    raise exception 'Apply tenant phone account fields first' using errcode='55000';
  end if;
  if not (contract->'features' @> '["phone.accounts.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["phone.accounts.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
