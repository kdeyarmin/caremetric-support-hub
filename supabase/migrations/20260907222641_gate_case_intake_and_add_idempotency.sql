-- Case intake is an explicitly activated, per-tenant/product capability.
-- An absent row and every newly inserted row fail closed.
create table private.case_intake_settings (
  tenant_id uuid not null,
  product_id uuid not null,
  enabled boolean not null default false,
  activated_at timestamptz,
  activated_by uuid references auth.users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, product_id),
  foreign key (tenant_id, product_id)
    references hub.tenant_products(tenant_id, product_id)
    on delete cascade,
  check (not enabled or (activated_at is not null and activated_by is not null))
);

-- The ledger stores only a request hash and identifiers. Message bodies,
-- subjects, and other support content must never be copied into this table.
create table private.support_request_keys (
  actor_id uuid not null references auth.users(id) on delete cascade,
  operation text not null check (operation in ('case.create', 'case.reply')),
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  case_id uuid references hub.support_cases(id) on delete cascade,
  entity_id uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (actor_id, operation, request_key),
  check (
    (completed_at is null and entity_id is null)
    or (completed_at is not null and case_id is not null and entity_id is not null)
  )
);

create index case_intake_settings_activated_by_idx
  on private.case_intake_settings(activated_by);
create index support_request_keys_case_id_idx
  on private.support_request_keys(case_id);

-- A role or membership row must stop authorizing immediately when Auth marks
-- its principal deleted, banned, or anonymous, even if an older JWT remains.
create or replace function private.current_user_is_usable()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users app_user
    where app_user.id = (select auth.uid())
      and app_user.deleted_at is null
      and (app_user.banned_until is null or app_user.banned_until <= now())
      and not coalesce(app_user.is_anonymous, false)
  );
$$;

create or replace function private.current_session_is_aal2()
returns boolean
language sql
stable
set search_path = ''
as $$
  select private.current_user_is_usable()
    and coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2';
$$;

create or replace function private.is_staff_principal()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_user_is_usable()
    and exists (
      select 1
      from private.staff_permissions permission
      where permission.user_id = (select auth.uid())
        and permission.revoked_at is null
    );
$$;

create or replace function private.current_principal_requires_aal2()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not private.current_user_is_usable()
    or private.is_staff_principal()
    or exists (
      select 1
      from auth.mfa_factors factor
      where factor.user_id = (select auth.uid())
        and factor.factor_type = 'totp'
        and factor.status = 'verified'
    );
$$;

revoke all on function private.current_user_is_usable() from public, anon, authenticated;
revoke all on function private.current_session_is_aal2() from public, anon, authenticated;
revoke all on function private.is_staff_principal() from public, anon, authenticated;
revoke all on function private.current_principal_requires_aal2() from public, anon, authenticated;

create or replace function hub.get_support_actor_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_profile hub.profiles%rowtype;
  v_membership hub.tenant_product_memberships%rowtype;
  v_tenant_name text;
  v_role text;
  v_is_staff boolean;
  v_requires_aal2 boolean;
begin
  if v_user_id is null or not private.current_user_is_usable() then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  select * into v_profile from hub.profiles where id = v_user_id;
  if v_profile.id is null then raise exception 'Support profile is not provisioned' using errcode = 'P0001'; end if;

  v_is_staff := private.is_staff_principal();
  v_requires_aal2 := private.current_principal_requires_aal2();

  if not v_requires_aal2 or private.current_session_is_aal2() then
    select * into v_membership
    from hub.tenant_product_memberships
    where user_id = v_user_id and status = 'active' and revoked_at is null
    order by joined_at
    limit 1;

    if v_membership.tenant_id is not null then
      select name into v_tenant_name from hub.tenants where id = v_membership.tenant_id;
    end if;
  end if;

  if v_is_staff then
    v_role := private.actor_role_label(v_user_id, null);
  else
    v_role := private.actor_role_label(v_user_id, v_membership.product_id);
  end if;
  return jsonb_build_object(
    'id', v_user_id,
    'name', v_profile.display_name,
    'role', v_role,
    'tenant_id', v_membership.tenant_id,
    'tenant_name', v_tenant_name
  );
end;
$$;

create trigger case_intake_settings_set_updated_at
before update on private.case_intake_settings
for each row execute function private.set_updated_at();

-- The original NULLS NOT DISTINCT constraint allowed only one historical
-- message without a client key per case. Preserve those rows while enforcing
-- unique non-null keys for every new reply.
alter table hub.case_messages
  drop constraint if exists case_messages_case_id_client_message_id_key;
create unique index if not exists case_messages_client_message_id_idx
  on hub.case_messages(case_id, client_message_id)
  where client_message_id is not null;

alter table private.case_notes
  add column if not exists client_message_id uuid;
create unique index if not exists case_notes_client_message_id_idx
  on private.case_notes(case_id, client_message_id)
  where client_message_id is not null;

alter table private.case_intake_settings enable row level security;
alter table private.support_request_keys enable row level security;
revoke all on table private.case_intake_settings from public, anon, authenticated;
revoke all on table private.support_request_keys from public, anon, authenticated;

create or replace function private.is_case_intake_enabled(
  p_tenant_id uuid,
  p_product_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.case_intake_settings setting
    join hub.tenant_products entitlement
      on entitlement.tenant_id = setting.tenant_id
     and entitlement.product_id = setting.product_id
    join hub.tenants tenant on tenant.id = setting.tenant_id
    join hub.products product on product.id = setting.product_id
    where setting.tenant_id = p_tenant_id
      and setting.product_id = p_product_id
      and setting.enabled
      and setting.activated_at is not null
      and setting.activated_by is not null
      and entitlement.status = 'active'
      and tenant.status = 'active'
      and product.status <> 'retired'
      and product.support_enabled
      and exists (
        select 1
        from private.staff_permissions permission
        join auth.users staff_user on staff_user.id = permission.user_id
        where permission.revoked_at is null
          and permission.permission in ('case.write', 'platform.admin')
          and (permission.product_id is null or permission.product_id = p_product_id)
          and staff_user.deleted_at is null
          and (staff_user.banned_until is null or staff_user.banned_until <= now())
          and not coalesce(staff_user.is_anonymous, false)
          and exists (
            select 1
            from hub.profiles staff_profile
            where staff_profile.id = permission.user_id
          )
          and exists (
            select 1
            from auth.mfa_factors factor
            where factor.user_id = permission.user_id
              and factor.factor_type = 'totp'
              and factor.status = 'verified'
          )
      )
  );
$$;

revoke all on function private.is_case_intake_enabled(uuid, uuid)
from public, anon, authenticated;

-- Idempotent overload. All parameters are explicit so PostgREST can
-- distinguish it from the existing nine-argument compatibility function.
create or replace function hub.create_support_case(
  p_tenant_id uuid,
  p_product_id uuid,
  p_subject text,
  p_category hub.case_category,
  p_priority hub.case_priority,
  p_body text,
  p_app_version text,
  p_route text,
  p_contains_phi boolean,
  p_request_key uuid
)
returns hub.support_case_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_display_name text;
  v_case_id uuid;
  v_role text;
  v_result hub.support_case_queue%rowtype;
  v_request_hash text;
  v_request private.support_request_keys%rowtype;
  v_inserted integer;
begin
  if v_user_id is null or not private.current_user_is_usable() then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_request_key is null then
    raise exception 'A request key is required.' using errcode = '22023';
  end if;
  if p_contains_phi is distinct from false then
    raise exception 'Remove patient or clinical information before creating this support case.' using errcode = 'P0001';
  end if;
  if not private.is_active_member(p_tenant_id, p_product_id) then
    raise exception 'No active product membership for this organization.' using errcode = '42501';
  end if;
  if p_subject is null or char_length(trim(p_subject)) not between 3 and 160 then
    raise exception 'Subject must be between 3 and 160 characters.' using errcode = '22023';
  end if;
  if p_category is null then
    raise exception 'Category is required.' using errcode = '22023';
  end if;
  if p_priority is null then
    raise exception 'Priority is required.' using errcode = '22023';
  end if;
  if p_body is null or char_length(trim(p_body)) not between 10 and 5000 then
    raise exception 'Message must be between 10 and 5000 characters.' using errcode = '22023';
  end if;
  if p_app_version is not null and char_length(trim(p_app_version)) > 48 then
    raise exception 'App version must be no more than 48 characters.' using errcode = '22023';
  end if;
  if p_route is not null and char_length(trim(p_route)) > 256 then
    raise exception 'Route context must be no more than 256 characters.' using errcode = '22023';
  end if;
  if p_route like '%?%' or p_route like '%#%' then
    raise exception 'Route context cannot contain a query string or fragment.' using errcode = '22023';
  end if;

  select display_name into v_display_name
  from hub.profiles
  where id = v_user_id;
  if v_display_name is null then
    raise exception 'Support profile is not provisioned.' using errcode = 'P0001';
  end if;
  select case
    when membership.role = 'tenant_admin' then 'tenant_admin'
    else 'customer'
  end into v_role
  from hub.tenant_product_memberships membership
  where membership.user_id = v_user_id
    and membership.tenant_id = p_tenant_id
    and membership.product_id = p_product_id
    and membership.status = 'active'
    and membership.revoked_at is null;

  if p_request_key is not null then
    v_request_hash := encode(
      extensions.digest(
        jsonb_build_array(
          p_tenant_id,
          p_product_id,
          trim(p_subject),
          p_category::text,
          p_priority::text,
          trim(p_body),
          nullif(trim(p_app_version), ''),
          nullif(trim(p_route), ''),
          coalesce(p_contains_phi, false)
        )::text,
        'sha256'
      ),
      'hex'
    );

    insert into private.support_request_keys (
      actor_id,
      operation,
      request_key,
      request_hash
    ) values (
      v_user_id,
      'case.create',
      p_request_key,
      v_request_hash
    )
    on conflict (actor_id, operation, request_key) do nothing;

    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then
      select * into v_request
      from private.support_request_keys request
      where request.actor_id = v_user_id
        and request.operation = 'case.create'
        and request.request_key = p_request_key;

      if not found or v_request.request_hash is distinct from v_request_hash then
        raise exception 'Request key was already used with different case data.' using errcode = '22023';
      end if;
      if v_request.completed_at is null or v_request.case_id is null then
        raise exception 'The earlier case request did not complete. Use a new request key.' using errcode = 'P0001';
      end if;

      select * into v_result
      from hub.support_case_queue
      where id = v_request.case_id;
      if v_result.id is null then
        raise exception 'The earlier case request is no longer available.' using errcode = 'P0001';
      end if;
      return v_result;
    end if;
  end if;

  -- The activation gate applies only to a new mutation. An authorized replay
  -- must still return its committed result if intake is later disabled.
  if not private.is_case_intake_enabled(p_tenant_id, p_product_id) then
    raise exception 'Support case intake is not active for this organization and product. Use the central phone or email listed in Help.' using errcode = 'P0001';
  end if;

  insert into hub.support_cases (
    tenant_id,
    product_id,
    requester_id,
    requester_display_name,
    subject,
    category,
    priority,
    source,
    app_version,
    route,
    data_classification
  ) values (
    p_tenant_id,
    p_product_id,
    v_user_id,
    v_display_name,
    trim(p_subject),
    p_category,
    p_priority,
    'portal',
    nullif(trim(p_app_version), ''),
    nullif(trim(p_route), ''),
    'possible_phi'
  )
  returning id into v_case_id;

  insert into hub.case_participants (case_id, user_id, participant_role)
  values (v_case_id, v_user_id, 'requester');

  insert into hub.case_messages (
    case_id,
    author_id,
    author_display_name,
    author_role,
    body,
    data_classification
  ) values (
    v_case_id,
    v_user_id,
    v_display_name,
    v_role,
    trim(p_body),
    'possible_phi'
  );

  insert into private.audit_events (
    actor_id,
    action,
    entity_type,
    entity_id,
    tenant_id,
    product_id,
    case_id,
    changed_columns
  ) values (
    v_user_id,
    'case.created',
    'support_case',
    v_case_id,
    p_tenant_id,
    p_product_id,
    v_case_id,
    array['subject', 'category', 'priority', 'source']
  );

  if p_request_key is not null then
    update private.support_request_keys
    set case_id = v_case_id,
        entity_id = v_case_id,
        completed_at = now()
    where actor_id = v_user_id
      and operation = 'case.create'
      and request_key = p_request_key;
  end if;

  select * into v_result
  from hub.support_case_queue
  where id = v_case_id;
  return v_result;
end;
$$;

-- Existing callers retain their original signature and defaults.
create or replace function hub.create_support_case(
  p_tenant_id uuid,
  p_product_id uuid,
  p_subject text,
  p_category hub.case_category,
  p_priority hub.case_priority,
  p_body text,
  p_app_version text default null,
  p_route text default null,
  p_contains_phi boolean default false
)
returns hub.support_case_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result hub.support_case_queue%rowtype;
begin
  select * into v_result
  from hub.create_support_case(
    p_tenant_id,
    p_product_id,
    p_subject,
    p_category,
    p_priority,
    p_body,
    p_app_version,
    p_route,
    coalesce(p_contains_phi, false),
    gen_random_uuid()
  );
  return v_result;
end;
$$;

-- Idempotent overload. The legacy three-argument function remains available.
create or replace function hub.reply_to_support_case(
  p_case_id uuid,
  p_body text,
  p_visibility text,
  p_request_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_case hub.support_cases%rowtype;
  v_display_name text;
  v_role text;
  v_is_staff boolean;
  v_can_reply_as_member boolean;
  v_message_id uuid;
  v_now timestamptz := now();
  v_request_hash text;
  v_request private.support_request_keys%rowtype;
  v_inserted integer;
  v_response jsonb;
begin
  if v_user_id is null or not private.current_user_is_usable() then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_request_key is null then
    raise exception 'A request key is required.' using errcode = '22023';
  end if;
  if p_body is null or char_length(trim(p_body)) not between 1 and 5000 then
    raise exception 'Reply must be between 1 and 5000 characters.' using errcode = '22023';
  end if;
  if p_visibility is null or p_visibility not in ('customer', 'internal') then
    raise exception 'Invalid reply visibility.' using errcode = '22023';
  end if;

  select * into v_case
  from hub.support_cases
  where id = p_case_id;
  if v_case.id is null
     or not private.can_view_case(v_case.id, v_case.tenant_id, v_case.product_id, v_case.requester_id) then
    raise exception 'Support case not found.' using errcode = '42501';
  end if;

  v_is_staff := private.has_staff_permission('case.write', v_case.product_id);
  select private.is_active_member(v_case.tenant_id, v_case.product_id)
    and (
      v_case.requester_id = v_user_id
      or exists (
        select 1
        from hub.case_participants participant
        where participant.case_id = v_case.id
          and participant.user_id = v_user_id
          and participant.revoked_at is null
      )
      or exists (
        select 1
        from hub.tenant_product_memberships membership
        where membership.user_id = v_user_id
          and membership.tenant_id = v_case.tenant_id
          and membership.product_id = v_case.product_id
          and membership.status = 'active'
          and membership.revoked_at is null
          and membership.case_scope = 'tenant'
      )
    )
  into v_can_reply_as_member;
  if p_visibility = 'internal' and not v_is_staff then
    raise exception 'Only support staff can create internal notes.' using errcode = '42501';
  end if;
  if p_visibility = 'customer'
     and not (v_is_staff or v_can_reply_as_member) then
    raise exception 'No permission to reply to this case.' using errcode = '42501';
  end if;

  select display_name into v_display_name
  from hub.profiles
  where id = v_user_id;
  if v_display_name is null then
    raise exception 'Support profile is not provisioned.' using errcode = 'P0001';
  end if;
  if v_is_staff then
    v_role := private.actor_role_label(v_user_id, v_case.product_id);
  else
    select case
      when membership.role = 'tenant_admin' then 'tenant_admin'
      else 'customer'
    end into v_role
    from hub.tenant_product_memberships membership
    where membership.user_id = v_user_id
      and membership.tenant_id = v_case.tenant_id
      and membership.product_id = v_case.product_id
      and membership.status = 'active'
      and membership.revoked_at is null;
  end if;

  if p_request_key is not null then
    v_request_hash := encode(
      extensions.digest(
        jsonb_build_array(
          p_case_id,
          trim(p_body),
          p_visibility
        )::text,
        'sha256'
      ),
      'hex'
    );

    insert into private.support_request_keys (
      actor_id,
      operation,
      request_key,
      request_hash,
      case_id
    ) values (
      v_user_id,
      'case.reply',
      p_request_key,
      v_request_hash,
      p_case_id
    )
    on conflict (actor_id, operation, request_key) do nothing;

    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then
      select * into v_request
      from private.support_request_keys request
      where request.actor_id = v_user_id
        and request.operation = 'case.reply'
        and request.request_key = p_request_key;

      if not found or v_request.request_hash is distinct from v_request_hash then
        raise exception 'Request key was already used with different reply data.' using errcode = '22023';
      end if;
      if v_request.completed_at is null or v_request.entity_id is null then
        raise exception 'The earlier reply request did not complete. Use a new request key.' using errcode = 'P0001';
      end if;

      if p_visibility = 'internal' then
        select jsonb_build_object(
          'id', note.id,
          'case_id', note.case_id,
          'author_id', note.author_id,
          'author_name', note.author_display_name,
          'author_role', note.author_role,
          'visibility', 'internal',
          'body', note.body,
          'created_at', note.created_at
        ) into v_response
        from private.case_notes note
        where note.id = v_request.entity_id
          and note.case_id = p_case_id;
      else
        select jsonb_build_object(
          'id', message.id,
          'case_id', message.case_id,
          'author_id', message.author_id,
          'author_name', message.author_display_name,
          'author_role', message.author_role,
          'visibility', 'customer',
          'body', message.body,
          'created_at', message.created_at
        ) into v_response
        from hub.case_messages message
        where message.id = v_request.entity_id
          and message.case_id = p_case_id;
      end if;

      if v_response is null then
        raise exception 'The earlier reply request is no longer available.' using errcode = 'P0001';
      end if;
      return v_response;
    end if;
  end if;

  if p_visibility = 'internal' then
    insert into private.case_notes (
      case_id,
      author_id,
      author_display_name,
      author_role,
      body,
      client_message_id
    ) values (
      p_case_id,
      v_user_id,
      v_display_name,
      v_role,
      trim(p_body),
      p_request_key
    )
    returning id into v_message_id;
  else
    insert into hub.case_messages (
      case_id,
      author_id,
      author_display_name,
      author_role,
      body,
      client_message_id
    ) values (
      p_case_id,
      v_user_id,
      v_display_name,
      v_role,
      trim(p_body),
      p_request_key
    )
    returning id into v_message_id;

    update hub.support_cases
    set last_message_at = v_now,
        status = case
          when v_is_staff then 'waiting_on_customer'::hub.case_status
          else 'open'::hub.case_status
        end,
        resolved_at = null
    where id = p_case_id;
  end if;

  insert into private.audit_events (
    actor_id,
    action,
    entity_type,
    entity_id,
    tenant_id,
    product_id,
    case_id,
    changed_columns
  ) values (
    v_user_id,
    case when p_visibility = 'internal' then 'case.note_added' else 'case.reply_added' end,
    'case_message',
    v_message_id,
    v_case.tenant_id,
    v_case.product_id,
    p_case_id,
    array['body']
  );

  if p_request_key is not null then
    update private.support_request_keys
    set entity_id = v_message_id,
        completed_at = now()
    where actor_id = v_user_id
      and operation = 'case.reply'
      and request_key = p_request_key;
  end if;

  return jsonb_build_object(
    'id', v_message_id,
    'case_id', p_case_id,
    'author_id', v_user_id,
    'author_name', v_display_name,
    'author_role', v_role,
    'visibility', p_visibility,
    'body', trim(p_body),
    'created_at', v_now
  );
end;
$$;

create or replace function hub.reply_to_support_case(
  p_case_id uuid,
  p_body text,
  p_visibility text default 'customer'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return hub.reply_to_support_case(
    p_case_id,
    p_body,
    p_visibility,
    gen_random_uuid()
  );
end;
$$;

-- Output-column names in a RETURNS TABLE function are PL/pgSQL variables.
-- Qualify every thread query reference so PostgreSQL cannot confuse those
-- variables with the underlying table columns.
create or replace function hub.get_support_case_thread(p_case_id uuid)
returns table (
  id uuid,
  case_id uuid,
  author_id uuid,
  author_name text,
  author_role text,
  visibility text,
  body text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_product_id uuid;
  v_is_staff boolean;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not private.can_view_case_id(p_case_id) then
    raise exception 'Support case not found.' using errcode = '42501';
  end if;

  select support_case.product_id
  into v_product_id
  from hub.support_cases as support_case
  where support_case.id = p_case_id;

  v_is_staff := private.has_staff_permission('case.read', v_product_id)
    or private.has_staff_permission('case.write', v_product_id);

  return query
  select thread_entry.id, thread_entry.case_id, thread_entry.author_id,
    thread_entry.author_display_name, thread_entry.author_role,
    thread_entry.visibility, thread_entry.body, thread_entry.created_at
  from (
    select message.id, message.case_id, message.author_id,
      message.author_display_name, message.author_role, 'customer'::text as visibility,
      message.body, message.created_at
    from hub.case_messages as message
    where message.case_id = p_case_id
    union all
    select note.id, note.case_id, note.author_id,
      note.author_display_name, note.author_role, 'internal'::text as visibility,
      note.body, note.created_at
    from private.case_notes as note
    where note.case_id = p_case_id and v_is_staff
  ) as thread_entry
  order by thread_entry.created_at, thread_entry.id;
end;
$$;

revoke all on function hub.create_support_case(
  uuid,
  uuid,
  text,
  hub.case_category,
  hub.case_priority,
  text,
  text,
  text,
  boolean,
  uuid
) from public, anon, authenticated;
revoke all on function hub.create_support_case(
  uuid,
  uuid,
  text,
  hub.case_category,
  hub.case_priority,
  text,
  text,
  text,
  boolean
) from public, anon, authenticated;
revoke all on function hub.reply_to_support_case(uuid, text, text, uuid)
from public, anon, authenticated;
revoke all on function hub.reply_to_support_case(uuid, text, text)
from public, anon, authenticated;
revoke all on function hub.get_support_case_thread(uuid)
from public, anon;

grant execute on function hub.create_support_case(
  uuid,
  uuid,
  text,
  hub.case_category,
  hub.case_priority,
  text,
  text,
  text,
  boolean,
  uuid
) to authenticated;
grant execute on function hub.create_support_case(
  uuid,
  uuid,
  text,
  hub.case_category,
  hub.case_priority,
  text,
  text,
  text,
  boolean
) to authenticated;
grant execute on function hub.reply_to_support_case(uuid, text, text, uuid)
to authenticated;
grant execute on function hub.reply_to_support_case(uuid, text, text)
to authenticated;
grant execute on function hub.get_support_case_thread(uuid)
to authenticated;

notify pgrst, 'reload schema';
