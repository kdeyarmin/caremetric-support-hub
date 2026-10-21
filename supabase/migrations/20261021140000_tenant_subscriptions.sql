-- Manual tenant setup and subscription pricing for the platform administrator.
--
-- The super admin creates a customer tenant by hand, chooses its applications
-- and records each subscription's price per month or per year, or makes it
-- complimentary (free) with a reason and an optional end date. Tenants and their
-- application access stay in hub.tenants and hub.tenant_products, where
-- onboarding already creates them; pricing is private.
--
-- This is the Hub's subscription record. It never charges a card and does not
-- change Stripe or an application's own billing.
--
-- Every read and write is a closed RPC behind the current administrator
-- session; writes also need the command session (signed in within eight hours).
-- Writes check versions so stale edits never overwrite, and audits carry states
-- and amounts only, never free text.

create table private.tenant_subscriptions (
  tenant_id uuid not null,
  product_id uuid not null,
  plan_name text not null check (char_length(plan_name) between 1 and 80),
  price_cents integer not null check (price_cents between 0 and 100000000),
  billing_interval text not null check (billing_interval in ('month', 'year')),
  complimentary boolean not null default false,
  complimentary_reason text not null default '' check (char_length(complimentary_reason) <= 300),
  complimentary_until date,
  notes text not null default '' check (char_length(notes) <= 1000),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, product_id),
  foreign key (tenant_id, product_id) references hub.tenant_products(tenant_id, product_id) on delete cascade,
  -- A paid subscription has a price; free is expressed only as complimentary.
  check (complimentary or price_cents > 0),
  check (complimentary = (btrim(complimentary_reason) <> '')),
  check (complimentary or complimentary_until is null),
  -- When a complimentary period ends, the recorded price applies.
  check (complimentary_until is null or price_cents > 0)
);
alter table private.tenant_subscriptions enable row level security;
revoke all on private.tenant_subscriptions from public, anon, authenticated, service_role, hub_app_server;
comment on table private.tenant_subscriptions is 'Administrator-recorded subscription pricing per tenant and application; not a billing provider.';

-- One subscription record exactly as the administrator reviewed it: the closed
-- set of keys, plain text within bounds, and pricing that is either paid (a
-- price per month or year) or complimentary with a reason.
create function private.validate_tenant_subscription(p_record jsonb) returns void
language plpgsql stable set search_path='' as $$
declare field record; until_date date;
begin
  if p_record is null or jsonb_typeof(p_record)<>'object'
    or (select count(*) from jsonb_object_keys(p_record))<>8
    or not p_record ?& array['access_status','plan_name','price_cents','billing_interval','complimentary','complimentary_reason','complimentary_until','notes'] then
    raise exception 'Invalid subscription record.';
  end if;
  for field in select * from jsonb_each(p_record) loop
    if field.key='price_cents' then
      if jsonb_typeof(field.value)<>'number' or (field.value#>>'{}') !~ '^[0-9]{1,9}$' or (field.value#>>'{}')::integer>100000000 then
        raise exception 'Enter a price from $0 to $1,000,000.';
      end if;
    elsif field.key='complimentary' then
      if jsonb_typeof(field.value)<>'boolean' then raise exception 'Invalid subscription field.'; end if;
    elsif jsonb_typeof(field.value)<>'string' or length(field.value#>>'{}') > (case field.key
        when 'access_status' then 20
        when 'plan_name' then 80
        when 'billing_interval' then 10
        when 'complimentary_reason' then 300
        when 'complimentary_until' then 10
        when 'notes' then 1000
        else 0 end) or (field.value#>>'{}') ~ '[[:cntrl:]]' then
      raise exception 'Invalid subscription field.';
    end if;
  end loop;
  if p_record->>'access_status' not in ('active','suspended','closed')
    or btrim(p_record->>'plan_name')=''
    or p_record->>'billing_interval' not in ('month','year') then
    raise exception 'Invalid subscription details.';
  end if;
  if p_record->>'complimentary_until'<>'' then
    if p_record->>'complimentary_until' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Invalid complimentary end date.'; end if;
    until_date:=(p_record->>'complimentary_until')::date;
    if until_date>'2100-12-31'::date then raise exception 'Invalid complimentary end date.'; end if;
  end if;
  if (p_record->>'complimentary')::boolean then
    if btrim(p_record->>'complimentary_reason')='' then raise exception 'Record why the subscription is complimentary.'; end if;
    if until_date is not null and (p_record->>'price_cents')::integer=0 then
      raise exception 'Enter the price that applies after the complimentary period ends.';
    end if;
  else
    if (p_record->>'price_cents')::integer=0 then raise exception 'Enter a price, or make the subscription complimentary.'; end if;
    if p_record->>'complimentary_reason'<>'' or until_date is not null then
      raise exception 'Only a complimentary subscription has a complimentary reason or end date.';
    end if;
  end if;
end;
$$;

-- A tenant as the administrator sees it: details, whether an application
-- account is linked through onboarding, active members, and every application
-- with its access status and recorded pricing (null when none is recorded).
create function private.tenant_account(p_tenant_id uuid) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object(
    'id', t.id, 'slug', t.slug, 'name', t.name, 'industry', coalesce(t.industry, ''), 'status', t.status,
    'created_at', t.created_at, 'updated_at', t.updated_at,
    'linked', exists(select 1 from private.federated_tenants f where f.hub_tenant_id = t.id),
    'member_count', (select count(distinct m.user_id) from hub.tenant_product_memberships m where m.tenant_id = t.id and m.status = 'active'),
    'subscriptions', (select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', p.id, 'product_slug', p.slug, 'product_name', p.name, 'access_status', tp.status,
        'pricing', case when s.tenant_id is null then null else jsonb_build_object(
          'plan_name', s.plan_name, 'price_cents', s.price_cents, 'billing_interval', s.billing_interval,
          'complimentary', s.complimentary, 'complimentary_reason', s.complimentary_reason,
          'complimentary_until', coalesce(s.complimentary_until::text, ''), 'notes', s.notes,
          'version', s.version, 'updated_at', s.updated_at) end
      ) order by p.name), '[]'::jsonb)
      from hub.tenant_products tp join hub.products p on p.id = tp.product_id
      left join private.tenant_subscriptions s on s.tenant_id = tp.tenant_id and s.product_id = tp.product_id
      where tp.tenant_id = t.id)
  )
  from hub.tenants t where t.id = p_tenant_id;
$$;

-- Writes one subscription: adds the application to the tenant when it is new,
-- applies the access status and records the pricing, then audits amounts and
-- states only.
create function private.write_tenant_subscription(p_tenant_id uuid, p_product_id uuid, p_record jsonb, p_expected_version integer) returns void
language plpgsql set search_path='' as $$
declare v_access hub.tenant_products; old private.tenant_subscriptions; saved private.tenant_subscriptions; until_date date;
begin
  perform private.validate_tenant_subscription(p_record);
  if p_expected_version is null or p_expected_version<0 then raise exception 'Invalid subscription version.'; end if;
  until_date:=nullif(p_record->>'complimentary_until','')::date;
  select * into v_access from hub.tenant_products where tenant_id=p_tenant_id and product_id=p_product_id for update;
  select * into old from private.tenant_subscriptions where tenant_id=p_tenant_id and product_id=p_product_id for update;
  if coalesce(old.version,0) is distinct from p_expected_version then
    raise exception 'Subscription changed. Refresh and review before saving.';
  end if;
  if until_date is not null and until_date<current_date and until_date is distinct from old.complimentary_until then
    raise exception 'Choose a complimentary end date of today or later.';
  end if;
  if v_access.tenant_id is null then
    perform 1 from hub.products where id=p_product_id and status<>'retired';
    if not found then raise exception 'Choose a current application.'; end if;
    insert into hub.tenant_products(tenant_id,product_id,status) values(p_tenant_id,p_product_id,(p_record->>'access_status')::hub.tenant_status);
  elsif v_access.status::text<>p_record->>'access_status' then
    update hub.tenant_products set status=(p_record->>'access_status')::hub.tenant_status where tenant_id=p_tenant_id and product_id=p_product_id;
  end if;
  if old.tenant_id is null then
    insert into private.tenant_subscriptions(tenant_id,product_id,plan_name,price_cents,billing_interval,complimentary,complimentary_reason,complimentary_until,notes)
    values(p_tenant_id,p_product_id,btrim(p_record->>'plan_name'),(p_record->>'price_cents')::integer,p_record->>'billing_interval',
      (p_record->>'complimentary')::boolean,btrim(p_record->>'complimentary_reason'),until_date,btrim(p_record->>'notes'))
    returning * into saved;
  else
    update private.tenant_subscriptions set plan_name=btrim(p_record->>'plan_name'),price_cents=(p_record->>'price_cents')::integer,
      billing_interval=p_record->>'billing_interval',complimentary=(p_record->>'complimentary')::boolean,
      complimentary_reason=btrim(p_record->>'complimentary_reason'),complimentary_until=until_date,notes=btrim(p_record->>'notes'),
      version=version+1,updated_at=clock_timestamp()
    where tenant_id=p_tenant_id and product_id=p_product_id returning * into saved;
  end if;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,tenant_id,product_id,metadata)
    values(auth.uid(),case when old.tenant_id is null then 'tenant_subscription.add' else 'tenant_subscription.update' end,
      'tenant_subscription',p_tenant_id,p_tenant_id,p_product_id,jsonb_build_object('version',saved.version,
      'access_status',p_record->>'access_status','price_cents',saved.price_cents,'billing_interval',saved.billing_interval,
      'complimentary',saved.complimentary,'complimentary_until',saved.complimentary_until));
end;
$$;
revoke all on function private.validate_tenant_subscription(jsonb),private.tenant_account(uuid),
  private.write_tenant_subscription(uuid,uuid,jsonb,integer) from public,anon,authenticated,service_role,hub_app_server;

create function hub.list_tenant_accounts() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform hub.authorize_app_admin();
  return jsonb_build_object(
    'tenants',(select coalesce(jsonb_agg(private.tenant_account(t.id) order by t.name,t.id),'[]'::jsonb) from hub.tenants t),
    'products',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'slug',p.slug,'name',p.name,'status',p.status) order by p.name),'[]'::jsonb)
      from hub.products p where p.status<>'retired'),
    'loaded_at',now());
end;
$$;

-- Sets up a tenant by hand with its first applications, atomically. Slugs that
-- onboarding generates (carebase-…, support-…) stay reserved for it.
create function hub.create_tenant(p_record jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_tenant_id uuid; item jsonb; product_ids uuid[]:=array[]::uuid[]; v_product_id uuid;
begin
  perform hub.authorize_app_command();
  if p_record is null or jsonb_typeof(p_record)<>'object'
    or (select count(*) from jsonb_object_keys(p_record))<>4
    or not p_record ?& array['name','slug','industry','subscriptions']
    or jsonb_typeof(p_record->'name')<>'string' or jsonb_typeof(p_record->'slug')<>'string'
    or jsonb_typeof(p_record->'industry')<>'string' or jsonb_typeof(p_record->'subscriptions')<>'array' then
    raise exception 'Invalid tenant record.';
  end if;
  if char_length(btrim(p_record->>'name')) not between 2 and 180 or p_record->>'name' ~ '[[:cntrl:]]'
    or char_length(p_record->>'industry')>120 or p_record->>'industry' ~ '[[:cntrl:]]' then
    raise exception 'Invalid tenant details.';
  end if;
  if char_length(p_record->>'slug') not between 2 and 63 or p_record->>'slug' !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'Use a slug of lowercase letters, numbers and single hyphens.';
  end if;
  if p_record->>'slug' ~ '^(carebase|support)-' then
    raise exception 'Slugs beginning with carebase- or support- are reserved for app onboarding.';
  end if;
  if jsonb_array_length(p_record->'subscriptions')>20 then raise exception 'Invalid tenant record.'; end if;
  for item in select value from jsonb_array_elements(p_record->'subscriptions') loop
    if jsonb_typeof(item)<>'object' or jsonb_typeof(item->'product_id')<>'string'
      or item->>'product_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Invalid subscription record.';
    end if;
    v_product_id:=(item->>'product_id')::uuid;
    if v_product_id=any(product_ids) then raise exception 'Add each application once.'; end if;
    product_ids:=product_ids||v_product_id;
    perform private.validate_tenant_subscription(item-'product_id');
  end loop;
  if exists(select 1 from hub.tenants where slug=p_record->>'slug') then
    raise exception 'A tenant with this slug already exists.';
  end if;
  begin
    insert into hub.tenants(slug,name,industry) values(p_record->>'slug',btrim(p_record->>'name'),nullif(btrim(p_record->>'industry'),''))
      returning id into v_tenant_id;
  exception when unique_violation then
    raise exception 'A tenant with this slug already exists.';
  end;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,tenant_id,metadata)
    values(auth.uid(),'tenant.create','tenant',v_tenant_id,v_tenant_id,jsonb_build_object('status','active','applications',jsonb_array_length(p_record->'subscriptions')));
  for item in select value from jsonb_array_elements(p_record->'subscriptions') loop
    perform private.write_tenant_subscription(v_tenant_id,(item->>'product_id')::uuid,item-'product_id',0);
  end loop;
  return private.tenant_account(v_tenant_id);
end;
$$;

-- Edits a tenant's name, industry and status. The slug never changes.
create function hub.save_tenant(p_tenant_id uuid,p_record jsonb,p_expected_updated_at timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old hub.tenants;
begin
  perform hub.authorize_app_command();
  if p_record is null or jsonb_typeof(p_record)<>'object'
    or (select count(*) from jsonb_object_keys(p_record))<>3
    or not p_record ?& array['name','industry','status']
    or jsonb_typeof(p_record->'name')<>'string' or jsonb_typeof(p_record->'industry')<>'string' or jsonb_typeof(p_record->'status')<>'string' then
    raise exception 'Invalid tenant record.';
  end if;
  if char_length(btrim(p_record->>'name')) not between 2 and 180 or p_record->>'name' ~ '[[:cntrl:]]'
    or char_length(p_record->>'industry')>120 or p_record->>'industry' ~ '[[:cntrl:]]'
    or p_record->>'status' not in ('active','suspended','closed') then
    raise exception 'Invalid tenant details.';
  end if;
  select * into old from hub.tenants where id=p_tenant_id for update;
  if not found or old.updated_at is distinct from p_expected_updated_at then
    raise exception 'Tenant changed. Refresh and review before saving.';
  end if;
  update hub.tenants set name=btrim(p_record->>'name'),industry=nullif(btrim(p_record->>'industry'),''),
    status=(p_record->>'status')::hub.tenant_status where id=p_tenant_id;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,tenant_id,metadata)
    values(auth.uid(),'tenant.update','tenant',p_tenant_id,p_tenant_id,jsonb_build_object('status',p_record->>'status'));
  return private.tenant_account(p_tenant_id);
end;
$$;

-- Adds an application to a tenant (expected version 0) or edits its access
-- status and pricing (the version last read).
create function hub.save_tenant_subscription(p_tenant_id uuid,p_product_id uuid,p_record jsonb,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform hub.authorize_app_command();
  perform 1 from hub.tenants where id=p_tenant_id for update;
  if not found then raise exception 'Tenant not found.'; end if;
  perform private.write_tenant_subscription(p_tenant_id,p_product_id,p_record,p_expected_version);
  return private.tenant_account(p_tenant_id);
end;
$$;

revoke all on function hub.list_tenant_accounts(),hub.create_tenant(jsonb),hub.save_tenant(uuid,jsonb,timestamptz),
  hub.save_tenant_subscription(uuid,uuid,jsonb,integer) from public,anon;
grant execute on function hub.list_tenant_accounts(),hub.create_tenant(jsonb),hub.save_tenant(uuid,jsonb,timestamptz),
  hub.save_tenant_subscription(uuid,uuid,jsonb,integer) to authenticated;
