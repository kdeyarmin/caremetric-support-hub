-- CareMetric Support Hub v0.1
--
-- This file is the reviewed, migration-ready schema source for the initial
-- vertical slice. It is intentionally not placed in supabase/migrations yet:
-- the dedicated project must be selected first, then this schema is applied
-- with execute_sql for iteration and pulled into a CLI-generated migration.
--
-- The `hub` schema is the only application schema intended for Data API
-- exposure. `private` must remain unexposed.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists hub;
create schema if not exists private;

revoke all on schema hub from public;
revoke all on schema private from public, anon, authenticated;
grant usage on schema hub to anon, authenticated, service_role;
grant usage on schema private to authenticated, service_role;

alter default privileges for role postgres in schema hub revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema hub revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema hub revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema private revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema private revoke execute on functions from public, anon, authenticated;

create type hub.product_status as enum ('active', 'pilot', 'retired');
create type hub.tenant_status as enum ('active', 'suspended', 'closed');
create type hub.membership_role as enum ('customer', 'tenant_admin');
create type hub.case_scope as enum ('own', 'tenant');
create type hub.case_status as enum ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed');
create type hub.case_priority as enum ('low', 'normal', 'high', 'urgent');
create type hub.case_category as enum ('general', 'technical_issue', 'billing', 'training_content', 'account_access', 'feature_request');
create type hub.case_source as enum ('portal', 'in_app', 'email', 'phone', 'api');
create type hub.data_classification as enum ('none', 'possible_phi', 'confirmed_phi', 'redacted');
create type hub.content_kind as enum ('article', 'video', 'course');
create type hub.content_status as enum ('draft', 'review', 'published', 'retired');
create type hub.access_level as enum ('public', 'customer', 'staff');
create type hub.content_source as enum ('support_hub', 'penntrain', 'docstudio', 'legacy');
create type hub.review_state as enum ('draft', 'in_review', 'approved', 'rejected');
create type hub.contact_channel as enum ('email', 'phone', 'web');
create type private.staff_permission as enum ('case.read', 'case.write', 'content.read', 'content.write', 'sla.manage', 'tenant.manage', 'audit.read', 'platform.admin');

create table hub.products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug = lower(slug) and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (char_length(name) between 2 and 120),
  description text not null default '',
  status hub.product_status not null default 'pilot',
  support_enabled boolean not null default true,
  color text not null default '#0a7369' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table hub.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug = lower(slug) and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (char_length(name) between 2 and 180),
  industry text,
  status hub.tenant_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table hub.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 120),
  locale text not null default 'en-US' check (char_length(locale) between 2 and 16),
  timezone text not null default 'America/New_York' check (char_length(timezone) between 3 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table hub.tenant_products (
  tenant_id uuid not null references hub.tenants(id) on delete cascade,
  product_id uuid not null references hub.products(id) on delete restrict,
  plan_code text,
  support_tier text not null default 'standard',
  status hub.tenant_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, product_id)
);

create table hub.tenant_product_memberships (
  tenant_id uuid not null,
  product_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  role hub.membership_role not null default 'customer',
  case_scope hub.case_scope not null default 'own',
  can_manage_members boolean not null default false,
  status hub.tenant_status not null default 'active',
  joined_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (tenant_id, product_id, user_id),
  foreign key (tenant_id, product_id) references hub.tenant_products(tenant_id, product_id) on delete cascade,
  check ((status = 'active' and revoked_at is null) or status <> 'active')
);

create table private.staff_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid references hub.products(id) on delete cascade,
  permission private.staff_permission not null,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique nulls not distinct (user_id, product_id, permission)
);

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

create sequence hub.case_number_seq start with 1000 increment by 1 no cycle;

create table hub.support_cases (
  id uuid primary key default gen_random_uuid(),
  case_number bigint not null unique default nextval('hub.case_number_seq'),
  tenant_id uuid not null,
  product_id uuid not null,
  requester_id uuid not null references auth.users(id) on delete restrict,
  requester_display_name text not null check (char_length(requester_display_name) between 1 and 120),
  subject text not null check (char_length(subject) between 3 and 160),
  category hub.case_category not null default 'general',
  priority hub.case_priority not null default 'normal',
  status hub.case_status not null default 'open',
  source hub.case_source not null default 'portal',
  data_classification hub.data_classification not null default 'possible_phi',
  assigned_to uuid references auth.users(id) on delete set null,
  assigned_to_display_name text,
  app_version text check (app_version is null or char_length(app_version) <= 48),
  route text check (route is null or (char_length(route) <= 256 and route not like '%?%' and route not like '%#%')),
  environment text check (environment is null or environment in ('production', 'staging', 'development')),
  correlation_id text check (correlation_id is null or char_length(correlation_id) <= 96),
  last_message_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, product_id) references hub.tenant_products(tenant_id, product_id) on delete restrict,
  check ((status in ('resolved', 'closed') and resolved_at is not null) or status not in ('resolved', 'closed'))
);

-- Stores only request hashes and entity identifiers. Never copy support-case
-- subjects, message bodies, or other support content into this ledger.
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

create table hub.case_participants (
  case_id uuid not null references hub.support_cases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  participant_role text not null default 'participant',
  added_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (case_id, user_id)
);

create table hub.case_messages (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references hub.support_cases(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete restrict,
  author_display_name text not null check (char_length(author_display_name) between 1 and 120),
  author_role text not null check (author_role in ('customer', 'tenant_admin', 'support_agent', 'support_manager', 'platform_admin')),
  body text not null check (char_length(body) between 1 and 5000),
  data_classification hub.data_classification not null default 'possible_phi',
  client_message_id uuid,
  created_at timestamptz not null default now()
);

create table private.case_notes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references hub.support_cases(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete restrict,
  author_display_name text not null check (char_length(author_display_name) between 1 and 120),
  author_role text not null check (author_role in ('support_agent', 'support_manager', 'platform_admin')),
  body text not null check (char_length(body) between 1 and 5000),
  data_classification hub.data_classification not null default 'possible_phi',
  client_message_id uuid,
  created_at timestamptz not null default now()
);

create table private.case_sla (
  case_id uuid primary key references hub.support_cases(id) on delete cascade,
  policy_key text,
  policy_version integer,
  first_response_due_at timestamptz,
  first_response_at timestamptz,
  resolution_due_at timestamptz,
  retention_expires_at timestamptz,
  legal_hold boolean not null default false,
  updated_at timestamptz not null default now()
);

create table hub.support_contacts (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references hub.products(id) on delete cascade,
  tenant_id uuid references hub.tenants(id) on delete cascade,
  channel hub.contact_channel not null,
  label text not null check (char_length(label) between 2 and 100),
  value text not null check (char_length(value) between 2 and 240),
  hours text check (hours is null or char_length(hours) <= 160),
  priority_order integer not null default 100,
  is_active boolean not null default true,
  verified_at timestamptz,
  verified_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((verified_at is null and verified_by is null) or verified_at is not null)
);

create table hub.content_items (
  id uuid primary key default gen_random_uuid(),
  content_key text not null unique check (content_key = lower(content_key) and content_key ~ '^[a-z0-9]+(?:[.-][a-z0-9]+)*$'),
  kind hub.content_kind not null,
  status hub.content_status not null default 'draft',
  access_level hub.access_level not null default 'customer',
  owner_product_id uuid references hub.products(id) on delete restrict,
  owner_team text not null default 'CareMetric Support',
  default_locale text not null default 'en-US',
  source_system hub.content_source not null default 'support_hub',
  created_by uuid references auth.users(id) on delete set null,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table hub.content_revisions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references hub.content_items(id) on delete cascade,
  revision_no integer not null check (revision_no > 0),
  locale text not null default 'en-US',
  product_overlay_id uuid references hub.products(id) on delete restrict,
  title text not null check (char_length(title) between 2 and 180),
  summary text not null default '' check (char_length(summary) <= 500),
  body_markdown text,
  body_text text,
  variables jsonb not null default '{}'::jsonb check (jsonb_typeof(variables) = 'object'),
  source_hash text,
  source_version text,
  review_state hub.review_state not null default 'draft',
  created_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  unique nulls not distinct (item_id, revision_no, locale, product_overlay_id),
  unique (item_id, id),
  check ((review_state = 'approved' and approved_at is not null) or review_state <> 'approved')
);

create table hub.content_publications (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references hub.content_items(id) on delete cascade,
  revision_id uuid not null references hub.content_revisions(id) on delete restrict,
  product_id uuid not null references hub.products(id) on delete cascade,
  audience text[] not null default array['all']::text[],
  route_pattern text,
  app_version_min text,
  app_version_max text,
  published_at timestamptz not null default now(),
  expires_at timestamptz,
  published_by uuid references auth.users(id) on delete set null,
  unique (item_id, product_id),
  foreign key (item_id, revision_id) references hub.content_revisions(item_id, id) deferrable initially immediate,
  check (expires_at is null or expires_at > published_at)
);

create table hub.content_relations (
  parent_item_id uuid not null references hub.content_items(id) on delete cascade,
  child_item_id uuid not null references hub.content_items(id) on delete cascade,
  relation_type text not null check (relation_type in ('video', 'course', 'related')),
  position integer not null default 0,
  primary key (parent_item_id, child_item_id, relation_type),
  check (parent_item_id <> child_item_id)
);

create table hub.media_assets (
  id uuid primary key default gen_random_uuid(),
  content_item_id uuid not null references hub.content_items(id) on delete cascade,
  revision_id uuid not null references hub.content_revisions(id) on delete restrict,
  product_id uuid references hub.products(id) on delete restrict,
  renderer text not null default 'heygen',
  renderer_job_id text,
  storage_provider text not null default 'supabase',
  storage_key text,
  mime_type text,
  sha256 text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  caption_storage_key text,
  transcript_storage_key text,
  render_status text not null default 'rendering' check (render_status in ('rendering', 'review', 'ready', 'failed', 'retired')),
  data_classification hub.data_classification not null default 'none',
  access_level hub.access_level not null default 'customer',
  input_hash text,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique nulls not distinct (revision_id, product_id, input_hash),
  check (access_level <> 'public' or data_classification = 'none'),
  check (render_status <> 'ready' or (storage_key is not null and sha256 is not null))
);

create table hub.course_links (
  content_item_id uuid primary key references hub.content_items(id) on delete cascade,
  penntrain_course_id text not null unique,
  source_version text,
  launch_path text not null check (launch_path like '/%' and launch_path not like '//%' and launch_path not like '%://%'),
  duration_minutes integer check (duration_minutes is null or duration_minutes >= 0),
  level text,
  objectives text[] not null default array[]::text[],
  source_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

create table private.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  tenant_id uuid,
  product_id uuid,
  case_id uuid,
  correlation_id text,
  changed_columns text[] not null default array[]::text[],
  reason_code text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

comment on table private.audit_events is 'Append-only audit metadata. Never store subjects, message bodies, filenames, raw request payloads, or before/after row JSON.';

create table private.federation_issuers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references hub.products(id) on delete cascade,
  issuer text not null unique,
  audience text not null,
  jwks_url text not null,
  allowed_origins text[] not null default array[]::text[],
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table private.federated_principals (
  issuer_id uuid not null references private.federation_issuers(id) on delete cascade,
  external_subject_hash text not null,
  hub_user_id uuid not null references auth.users(id) on delete cascade,
  verified_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (issuer_id, external_subject_hash)
);

create table private.federated_tenants (
  issuer_id uuid not null references private.federation_issuers(id) on delete cascade,
  external_tenant_hash text not null,
  hub_tenant_id uuid not null references hub.tenants(id) on delete cascade,
  verified_at timestamptz not null default now(),
  primary key (issuer_id, external_tenant_hash)
);

create table private.context_nonces (
  jti_hash text primary key,
  issuer_id uuid not null references private.federation_issuers(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index tenant_product_memberships_user_active_idx on hub.tenant_product_memberships(user_id, tenant_id, product_id) where status = 'active';
create index staff_permissions_lookup_idx on private.staff_permissions(user_id, product_id, permission) where revoked_at is null;
create index support_cases_requester_idx on hub.support_cases(requester_id, updated_at desc);
create index support_cases_tenant_product_queue_idx on hub.support_cases(tenant_id, product_id, status, updated_at desc);
create index support_cases_assigned_idx on hub.support_cases(assigned_to, status, updated_at desc) where assigned_to is not null;
create index case_participants_user_idx on hub.case_participants(user_id, case_id) where revoked_at is null;
create index case_messages_case_time_idx on hub.case_messages(case_id, created_at, id);
create index case_messages_author_idx on hub.case_messages(author_id) where author_id is not null;
create unique index case_messages_client_message_id_idx on hub.case_messages(case_id, client_message_id) where client_message_id is not null;
create index case_notes_case_time_idx on private.case_notes(case_id, created_at, id);
create index case_notes_author_idx on private.case_notes(author_id) where author_id is not null;
create unique index case_notes_client_message_id_idx on private.case_notes(case_id, client_message_id) where client_message_id is not null;
create index case_intake_settings_activated_by_idx on private.case_intake_settings(activated_by);
create index support_request_keys_case_id_idx on private.support_request_keys(case_id);
create index content_publications_product_idx on hub.content_publications(product_id, published_at desc);
create index content_publications_revision_idx on hub.content_publications(revision_id);
create index content_publications_item_revision_idx on hub.content_publications(item_id, revision_id);
create index content_publications_published_by_idx on hub.content_publications(published_by) where published_by is not null;
create index content_revisions_item_idx on hub.content_revisions(item_id, locale, revision_no desc);
create index content_revisions_overlay_idx on hub.content_revisions(product_overlay_id) where product_overlay_id is not null;
create index content_revisions_created_by_idx on hub.content_revisions(created_by) where created_by is not null;
create index content_revisions_approved_by_idx on hub.content_revisions(approved_by) where approved_by is not null;
create index content_items_owner_product_idx on hub.content_items(owner_product_id) where owner_product_id is not null;
create index content_items_created_by_idx on hub.content_items(created_by) where created_by is not null;
create index content_relations_child_idx on hub.content_relations(child_item_id);
create index media_assets_content_item_idx on hub.media_assets(content_item_id);
create index media_assets_product_idx on hub.media_assets(product_id) where product_id is not null;
create index support_contacts_product_idx on hub.support_contacts(product_id) where product_id is not null;
create index support_contacts_tenant_idx on hub.support_contacts(tenant_id) where tenant_id is not null;
create index support_contacts_verified_by_idx on hub.support_contacts(verified_by) where verified_by is not null;
create index tenant_products_product_idx on hub.tenant_products(product_id);
create index staff_permissions_product_idx on private.staff_permissions(product_id) where product_id is not null;
create index staff_permissions_granted_by_idx on private.staff_permissions(granted_by) where granted_by is not null;
create index federation_issuers_product_idx on private.federation_issuers(product_id);
create index federated_principals_user_idx on private.federated_principals(hub_user_id);
create index federated_tenants_tenant_idx on private.federated_tenants(hub_tenant_id);
create index context_nonces_issuer_idx on private.context_nonces(issuer_id);
create index audit_events_case_idx on private.audit_events(case_id, created_at desc) where case_id is not null;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger products_set_updated_at before update on hub.products for each row execute function private.set_updated_at();
create trigger tenants_set_updated_at before update on hub.tenants for each row execute function private.set_updated_at();
create trigger profiles_set_updated_at before update on hub.profiles for each row execute function private.set_updated_at();
create trigger tenant_products_set_updated_at before update on hub.tenant_products for each row execute function private.set_updated_at();
create trigger case_intake_settings_set_updated_at before update on private.case_intake_settings for each row execute function private.set_updated_at();
create trigger support_cases_set_updated_at before update on hub.support_cases for each row execute function private.set_updated_at();
create trigger support_contacts_set_updated_at before update on hub.support_contacts for each row execute function private.set_updated_at();
create trigger content_items_set_updated_at before update on hub.content_items for each row execute function private.set_updated_at();
create trigger course_links_set_updated_at before update on hub.course_links for each row execute function private.set_updated_at();

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into hub.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(coalesce(new.email, 'CareMetric user'), '@', 1)), 120)
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.handle_new_user();
drop trigger if exists on_auth_user_confirmed on auth.users;

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

revoke all on function private.current_user_is_usable() from public, anon, authenticated;
revoke all on function private.current_session_is_aal2() from public, anon, authenticated;
revoke all on function private.is_staff_principal() from public, anon, authenticated;
revoke all on function private.current_principal_requires_aal2() from public, anon, authenticated;
revoke all on function private.is_case_intake_enabled(uuid, uuid) from public, anon, authenticated;

create or replace function private.has_staff_permission(p_permission private.staff_permission, p_product_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_session_is_aal2()
    and (select auth.uid()) is not null
    and exists (
      select 1
      from private.staff_permissions sp
      where sp.user_id = (select auth.uid())
        and sp.revoked_at is null
        and (sp.permission = p_permission or sp.permission = 'platform.admin')
        and (sp.product_id is null or sp.product_id = p_product_id)
    );
$$;

create or replace function private.is_support_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_session_is_aal2()
    and (select auth.uid()) is not null
    and exists (
      select 1
      from private.staff_permissions permission
      where permission.user_id = (select auth.uid())
        and permission.revoked_at is null
        and permission.permission in ('case.read', 'case.write', 'content.read', 'content.write', 'sla.manage', 'tenant.manage', 'audit.read', 'platform.admin')
    );
$$;

create or replace function private.is_active_member(p_tenant_id uuid, p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and (not private.current_principal_requires_aal2() or private.current_session_is_aal2())
    and exists (
      select 1
      from hub.tenant_product_memberships membership
      join hub.tenant_products entitlement
        on entitlement.tenant_id = membership.tenant_id
       and entitlement.product_id = membership.product_id
      join hub.tenants tenant on tenant.id = membership.tenant_id
      join hub.products product on product.id = membership.product_id
      where membership.user_id = (select auth.uid())
        and membership.tenant_id = p_tenant_id
        and membership.product_id = p_product_id
        and membership.status = 'active'
        and membership.revoked_at is null
        and entitlement.status = 'active'
        and tenant.status = 'active'
        and product.status <> 'retired'
        and product.support_enabled
    );
$$;

create or replace function private.can_read_membership_row(
  p_tenant_id uuid,
  p_product_id uuid,
  p_target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and (not private.current_principal_requires_aal2() or private.current_session_is_aal2())
    and (
      p_target_user_id = (select auth.uid())
      or (
        private.is_active_member(p_tenant_id, p_product_id)
        and exists (
          select 1
          from hub.tenant_product_memberships self_membership
          where self_membership.tenant_id = p_tenant_id
            and self_membership.product_id = p_product_id
            and self_membership.user_id = (select auth.uid())
            and self_membership.role = 'tenant_admin'
            and self_membership.can_manage_members
            and self_membership.status = 'active'
            and self_membership.revoked_at is null
        )
      )
      or private.has_staff_permission('tenant.manage', p_product_id)
    );
$$;

create or replace function private.can_view_case(
  p_case_id uuid,
  p_tenant_id uuid,
  p_product_id uuid,
  p_requester_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and (
    private.has_staff_permission('case.read', p_product_id)
    or private.has_staff_permission('case.write', p_product_id)
    or (
      private.is_active_member(p_tenant_id, p_product_id)
      and (
        p_requester_id = (select auth.uid())
        or exists (
          select 1 from hub.case_participants participant
          where participant.case_id = p_case_id
            and participant.user_id = (select auth.uid())
            and participant.revoked_at is null
        )
        or exists (
          select 1 from hub.tenant_product_memberships membership
          where membership.user_id = (select auth.uid())
            and membership.tenant_id = p_tenant_id
            and membership.product_id = p_product_id
            and membership.status = 'active'
            and membership.revoked_at is null
            and membership.case_scope = 'tenant'
        )
      )
    )
  );
$$;

create or replace function private.can_view_case_id(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from hub.support_cases support_case
    where support_case.id = p_case_id
      and private.can_view_case(
        support_case.id,
        support_case.tenant_id,
        support_case.product_id,
        support_case.requester_id
      )
  );
$$;

create or replace function private.can_view_content_item(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from hub.content_items item
    where item.id = p_item_id
      and (
        private.has_staff_permission('content.read', item.owner_product_id)
        or private.has_staff_permission('content.write', item.owner_product_id)
        or (
          item.status = 'published'
          and exists (
            select 1
            from hub.content_publications publication
            where publication.item_id = item.id
              and publication.published_at <= now()
              and (publication.expires_at is null or publication.expires_at > now())
              and (
                item.access_level = 'public'
                or (
                  item.access_level = 'customer'
                  and private.is_active_member(
                    (select membership.tenant_id
                     from hub.tenant_product_memberships membership
                     where membership.user_id = (select auth.uid())
                       and membership.product_id = publication.product_id
                       and membership.status = 'active'
                       and membership.revoked_at is null
                     limit 1),
                    publication.product_id
                  )
                )
              )
          )
        )
      )
  );
$$;

revoke all on function private.has_staff_permission(private.staff_permission, uuid) from public, anon;
revoke all on function private.is_support_staff() from public, anon;
revoke all on function private.is_active_member(uuid, uuid) from public, anon;
revoke all on function private.can_read_membership_row(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.can_view_case(uuid, uuid, uuid, uuid) from public, anon;
revoke all on function private.can_view_case_id(uuid) from public, anon;
revoke all on function private.can_view_content_item(uuid) from public, anon;
grant execute on function private.has_staff_permission(private.staff_permission, uuid) to authenticated;
grant execute on function private.is_support_staff() to authenticated;
grant execute on function private.is_active_member(uuid, uuid) to authenticated;
grant execute on function private.can_read_membership_row(uuid, uuid, uuid) to authenticated;
grant execute on function private.can_view_case(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function private.can_view_case_id(uuid) to authenticated;
grant execute on function private.can_view_content_item(uuid) to anon, authenticated;

alter table hub.products enable row level security;
alter table hub.tenants enable row level security;
alter table hub.profiles enable row level security;
alter table hub.tenant_products enable row level security;
alter table hub.tenant_product_memberships enable row level security;
alter table hub.support_cases enable row level security;
alter table hub.case_participants enable row level security;
alter table hub.case_messages enable row level security;
alter table hub.support_contacts enable row level security;
alter table hub.content_items enable row level security;
alter table hub.content_revisions enable row level security;
alter table hub.content_publications enable row level security;
alter table hub.content_relations enable row level security;
alter table hub.media_assets enable row level security;
alter table hub.course_links enable row level security;
alter table private.staff_permissions enable row level security;
alter table private.case_intake_settings enable row level security;
alter table private.support_request_keys enable row level security;
alter table private.case_notes enable row level security;
alter table private.case_sla enable row level security;
alter table private.audit_events enable row level security;
alter table private.federation_issuers enable row level security;
alter table private.federated_principals enable row level security;
alter table private.federated_tenants enable row level security;
alter table private.context_nonces enable row level security;

create policy products_public_read on hub.products for select to anon, authenticated
using (status <> 'retired' and support_enabled);

create policy tenants_member_read on hub.tenants for select to authenticated
using (
  exists (
    select 1 from hub.tenant_product_memberships membership
    where membership.tenant_id = id
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
      and membership.revoked_at is null
  )
  or private.is_support_staff()
);

create policy profiles_self_or_staff_read on hub.profiles for select to authenticated
using (
  id = (select auth.uid())
  or private.has_staff_permission('case.read', null)
  or private.has_staff_permission('case.write', null)
  or private.has_staff_permission('tenant.manage', null)
);

create policy tenant_products_member_read on hub.tenant_products for select to authenticated
using (
  private.is_active_member(tenant_id, product_id)
  or private.has_staff_permission('case.read', product_id)
  or private.has_staff_permission('tenant.manage', product_id)
);

create policy memberships_self_or_admin_read on hub.tenant_product_memberships for select to authenticated
using (
  private.can_read_membership_row(tenant_id, product_id, user_id)
);

create policy support_cases_read on hub.support_cases for select to authenticated
using (private.can_view_case(id, tenant_id, product_id, requester_id));

create policy case_participants_read on hub.case_participants for select to authenticated
using (private.can_view_case_id(case_id));

create policy case_messages_read on hub.case_messages for select to authenticated
using (private.can_view_case_id(case_id));

create policy support_contacts_public_read on hub.support_contacts for select to anon
using (is_active and verified_at is not null and tenant_id is null);

create policy support_contacts_authenticated_read on hub.support_contacts for select to authenticated
using (
  (is_active and verified_at is not null and tenant_id is null)
  or private.has_staff_permission('tenant.manage', product_id)
);

create policy content_items_read on hub.content_items for select to anon, authenticated
using (private.can_view_content_item(id));

create policy content_revisions_read on hub.content_revisions for select to anon, authenticated
using (
  private.can_view_content_item(item_id)
  and (
    review_state = 'approved'
    or private.has_staff_permission('content.read', product_overlay_id)
    or private.has_staff_permission('content.write', product_overlay_id)
  )
);

create policy content_publications_read on hub.content_publications for select to anon, authenticated
using (private.can_view_content_item(item_id));

create policy content_relations_read on hub.content_relations for select to anon, authenticated
using (private.can_view_content_item(parent_item_id) and private.can_view_content_item(child_item_id));

create policy media_assets_read on hub.media_assets for select to anon, authenticated
using (
  private.can_view_content_item(content_item_id)
  and (render_status = 'ready' or private.has_staff_permission('content.read', product_id))
);

create policy course_links_read on hub.course_links for select to anon, authenticated
using (private.can_view_content_item(content_item_id));

grant select on hub.products to anon, authenticated;
grant select on hub.tenants, hub.profiles, hub.tenant_products, hub.tenant_product_memberships to authenticated;
grant select on hub.support_cases, hub.case_participants, hub.case_messages to authenticated;
grant select on hub.support_contacts to anon, authenticated;
grant select on hub.content_items, hub.content_revisions, hub.content_publications, hub.content_relations, hub.media_assets, hub.course_links to anon, authenticated;

create or replace view hub.support_case_queue
with (security_invoker = true)
as
select
  support_case.id,
  support_case.case_number,
  support_case.tenant_id,
  tenant.name as tenant_name,
  support_case.product_id,
  support_case.requester_id,
  support_case.requester_display_name as requester_name,
  support_case.subject,
  support_case.category,
  support_case.priority,
  support_case.status,
  support_case.source,
  support_case.assigned_to,
  support_case.assigned_to_display_name as assigned_to_name,
  support_case.app_version,
  support_case.route,
  support_case.created_at,
  support_case.updated_at,
  support_case.last_message_at
from hub.support_cases support_case
join hub.tenants tenant on tenant.id = support_case.tenant_id;

grant select on hub.support_case_queue to authenticated;

create or replace view hub.published_content
with (security_invoker = true)
as
select
  item.id,
  item.content_key,
  item.kind,
  revision.title,
  revision.summary,
  revision.body_markdown,
  item.status,
  item.access_level,
  array_agg(distinct publication.product_id) as product_ids,
  array_agg(distinct audience_item) filter (where audience_item is not null) as audience,
  revision.locale,
  revision.revision_no,
  item.source_system,
  min(publication.route_pattern) as route_pattern,
  max(media.render_status) as video_status,
  max(course.launch_path) as course_launch_path
from hub.content_items item
join hub.content_publications publication on publication.item_id = item.id
join hub.content_revisions revision on revision.id = publication.revision_id
left join lateral unnest(publication.audience) as audience_item on true
left join hub.media_assets media on media.content_item_id = item.id and media.revision_id = revision.id
left join hub.course_links course on course.content_item_id = item.id
where item.status = 'published'
  and publication.published_at <= now()
  and (publication.expires_at is null or publication.expires_at > now())
group by item.id, revision.id;

grant select on hub.published_content to anon, authenticated;

create or replace function private.actor_role_label(p_user_id uuid, p_product_id uuid default null)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from private.staff_permissions sp where sp.user_id = p_user_id and sp.permission = 'platform.admin' and sp.revoked_at is null) then 'platform_admin'
    when exists (select 1 from private.staff_permissions sp where sp.user_id = p_user_id and sp.permission in ('content.write', 'sla.manage', 'tenant.manage') and sp.revoked_at is null and (p_product_id is null or sp.product_id is null or sp.product_id = p_product_id)) then 'support_manager'
    when exists (select 1 from private.staff_permissions sp where sp.user_id = p_user_id and sp.permission in ('case.read', 'case.write', 'content.read', 'audit.read') and sp.revoked_at is null and (p_product_id is null or sp.product_id is null or sp.product_id = p_product_id)) then 'support_agent'
    when exists (select 1 from hub.tenant_product_memberships membership where membership.user_id = p_user_id and membership.product_id = p_product_id and membership.role = 'tenant_admin' and membership.status = 'active' and membership.revoked_at is null) then 'tenant_admin'
    else 'customer'
  end;
$$;

revoke all on function private.actor_role_label(uuid, uuid) from public, anon, authenticated;

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
  v_memberships jsonb := '[]'::jsonb;
  v_primary_membership jsonb;
  v_has_tenant_admin boolean := false;
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
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'tenant_id', membership.tenant_id,
            'tenant_name', tenant.name,
            'product_id', membership.product_id,
            'role', membership.role,
            'intake_enabled', private.is_case_intake_enabled(
              membership.tenant_id,
              membership.product_id
            )
          )
          order by membership.joined_at, membership.tenant_id, membership.product_id
        ),
        '[]'::jsonb
      ),
      coalesce(bool_or(membership.role = 'tenant_admin'), false)
    into v_memberships, v_has_tenant_admin
    from hub.tenant_product_memberships membership
    join hub.tenant_products entitlement
      on entitlement.tenant_id = membership.tenant_id
     and entitlement.product_id = membership.product_id
    join hub.tenants tenant on tenant.id = membership.tenant_id
    join hub.products product on product.id = membership.product_id
    where membership.user_id = v_user_id
      and membership.status = 'active'
      and membership.revoked_at is null
      and entitlement.status = 'active'
      and tenant.status = 'active'
      and product.status <> 'retired'
      and product.support_enabled;
  end if;

  if v_is_staff then
    v_role := private.actor_role_label(v_user_id, null);
  elsif v_has_tenant_admin then
    v_role := 'tenant_admin';
  else
    v_role := 'customer';
  end if;
  v_primary_membership := v_memberships -> 0;
  return jsonb_build_object(
    'id', v_user_id,
    'name', v_profile.display_name,
    'role', v_role,
    'tenant_id', v_primary_membership ->> 'tenant_id',
    'tenant_name', v_primary_membership ->> 'tenant_name',
    'memberships', v_memberships
  );
end;
$$;

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
  if (select auth.uid()) is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if not private.can_view_case_id(p_case_id) then raise exception 'Support case not found.' using errcode = '42501'; end if;
  select support_case.product_id
  into v_product_id
  from hub.support_cases as support_case
  where support_case.id = p_case_id;
  v_is_staff := private.has_staff_permission('case.read', v_product_id) or private.has_staff_permission('case.write', v_product_id);

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

create or replace function hub.update_support_case(
  p_case_id uuid,
  p_status hub.case_status default null,
  p_priority hub.case_priority default null,
  p_assigned_to uuid default null,
  p_change_assignment boolean default false
)
returns hub.support_case_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_case hub.support_cases%rowtype;
  v_assignee_name text;
  v_changed text[] := array[]::text[];
  v_result hub.support_case_queue%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into v_case from hub.support_cases where id = p_case_id;
  if v_case.id is null or not private.has_staff_permission('case.write', v_case.product_id) then
    raise exception 'Support case not found.' using errcode = '42501';
  end if;

  if p_change_assignment and p_assigned_to is not null then
    if not exists (
      select 1
      from private.staff_permissions permission
      join auth.users assignee on assignee.id = permission.user_id
      join hub.profiles assignee_profile on assignee_profile.id = permission.user_id
      where permission.user_id = p_assigned_to
        and permission.revoked_at is null
        and permission.permission in ('case.read', 'case.write', 'platform.admin')
        and (permission.product_id is null or permission.product_id = v_case.product_id)
        and assignee.deleted_at is null
        and (assignee.banned_until is null or assignee.banned_until <= now())
        and not coalesce(assignee.is_anonymous, false)
    ) then raise exception 'Assignee is not authorized for this product.' using errcode = '42501'; end if;
    select display_name into v_assignee_name from hub.profiles where id = p_assigned_to;
  end if;

  if p_status is not null then v_changed := array_append(v_changed, 'status'); end if;
  if p_priority is not null then v_changed := array_append(v_changed, 'priority'); end if;
  if p_change_assignment then v_changed := array_append(v_changed, 'assigned_to'); end if;

  update hub.support_cases
  set status = coalesce(p_status, status),
      priority = coalesce(p_priority, priority),
      assigned_to = case when p_change_assignment then p_assigned_to else assigned_to end,
      assigned_to_display_name = case when p_change_assignment then v_assignee_name else assigned_to_display_name end,
      resolved_at = case
        when p_status in ('resolved', 'closed') then coalesce(resolved_at, now())
        when p_status is not null then null
        else resolved_at
      end
  where id = p_case_id;

  insert into private.audit_events (actor_id, action, entity_type, entity_id, tenant_id, product_id, case_id, changed_columns)
  values (v_user_id, 'case.updated', 'support_case', p_case_id, v_case.tenant_id, v_case.product_id, p_case_id, v_changed);

  select * into v_result from hub.support_case_queue where id = p_case_id;
  return v_result;
end;
$$;

revoke all on function hub.get_support_actor_context() from public, anon;
revoke all on function hub.create_support_case(uuid, uuid, text, hub.case_category, hub.case_priority, text, text, text, boolean) from public, anon, authenticated;
revoke all on function hub.create_support_case(uuid, uuid, text, hub.case_category, hub.case_priority, text, text, text, boolean, uuid) from public, anon, authenticated;
revoke all on function hub.get_support_case_thread(uuid) from public, anon;
revoke all on function hub.reply_to_support_case(uuid, text, text) from public, anon, authenticated;
revoke all on function hub.reply_to_support_case(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function hub.update_support_case(uuid, hub.case_status, hub.case_priority, uuid, boolean) from public, anon;
grant execute on function hub.get_support_actor_context() to authenticated;
grant execute on function hub.create_support_case(uuid, uuid, text, hub.case_category, hub.case_priority, text, text, text, boolean) to authenticated;
grant execute on function hub.create_support_case(uuid, uuid, text, hub.case_category, hub.case_priority, text, text, text, boolean, uuid) to authenticated;
grant execute on function hub.get_support_case_thread(uuid) to authenticated;
grant execute on function hub.reply_to_support_case(uuid, text, text) to authenticated;
grant execute on function hub.reply_to_support_case(uuid, text, text, uuid) to authenticated;
grant execute on function hub.update_support_case(uuid, hub.case_status, hub.case_priority, uuid, boolean) to authenticated;

-- The client roles deliberately receive no INSERT, UPDATE, or DELETE grants on
-- support/content tables. Atomic RPCs or future authenticated Edge Functions
-- are the write boundary.
revoke insert, update, delete on all tables in schema hub from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;
revoke all on all sequences in schema hub from anon, authenticated;
revoke all on all sequences in schema private from anon, authenticated;

-- Expose the application schema through PostgREST while keeping both public
-- and private out of the Data API surface. This is an intentional manual
-- override; changes must be made through reviewed migrations.
alter role authenticator set pgrst.db_schemas = 'hub';
notify pgrst, 'reload config';

-- Product registry and owner-verified central support routing.
insert into hub.products (id, slug, name, description, status, color)
values
  ('00000000-0000-4000-8000-000000000001', 'carebase', 'CareMetric CareBase', 'Operations, compliance, workforce, and learning management.', 'active', '#0a7a70'),
  ('00000000-0000-4000-8000-000000000002', 'breathe', 'CareMetric Breathe', 'DME resupply, mask fitting, and patient engagement.', 'active', '#2378c8'),
  ('00000000-0000-4000-8000-000000000003', 'pennsync', 'PennSync', 'Clinical documentation assistance and OASIS workflow support.', 'pilot', '#7654c6'),
  ('00000000-0000-4000-8000-000000000004', 'caremetric-emr', 'CareMetric EMR', 'Care delivery, scheduling, billing, and practice operations.', 'pilot', '#c46a25'),
  ('00000000-0000-4000-8000-000000000005', 'caremetric-go', 'CareMetric Go', 'Secure companion clinical app and patient portal for CareMetric AI.', 'pilot', '#2563eb'),
  ('00000000-0000-4000-8000-000000000006', 'caremetric-intel', 'CareMetric Intel', 'Healthcare provider intelligence, CRM, and analytics for post-acute organizations.', 'pilot', '#0891b2')
on conflict (id) do update set
  slug = excluded.slug,
  name = excluded.name,
  description = excluded.description,
  status = excluded.status,
  color = excluded.color;

insert into hub.support_contacts (id, channel, label, value, hours, priority_order, verified_at)
values
  ('10000000-0000-4000-8000-000000000001', 'web', 'Central support portal', 'https://support-hub-web-production.up.railway.app', 'Available anytime', 1, now()),
  ('10000000-0000-4000-8000-000000000002', 'phone', 'Central support phone', '+18775212890', null, 2, now()),
  ('10000000-0000-4000-8000-000000000003', 'email', 'Central support email', 'support@caremetric.ai', null, 3, now())
on conflict (id) do update set
  product_id = null,
  tenant_id = null,
  label = excluded.label,
  value = excluded.value,
  hours = excluded.hours,
  priority_order = excluded.priority_order,
  is_active = true,
  verified_at = excluded.verified_at,
  updated_at = now();

insert into hub.content_items (id, content_key, kind, status, access_level, source_system)
values
  ('20000000-0000-4000-8000-000000000001', 'support.protect-patient-information', 'article', 'published', 'public', 'support_hub'),
  ('20000000-0000-4000-8000-000000000002', 'account.invite-user', 'article', 'published', 'customer', 'support_hub'),
  ('20000000-0000-4000-8000-000000000003', 'account.invite-user.video', 'video', 'review', 'customer', 'support_hub'),
  ('20000000-0000-4000-8000-000000000004', 'course.team-onboarding', 'course', 'published', 'customer', 'penntrain')
on conflict (id) do nothing;

insert into hub.content_revisions (
  id, item_id, revision_no, title, summary, body_markdown, body_text,
  review_state, approved_by, approved_at, source_hash
)
values
  (
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    1,
    'Protect patient information in support requests',
    'What to include—and what never to include—when asking for software support.',
    'Describe the workflow, product, page, expected behavior, and error wording. Do not include patient names, dates of birth, medical record numbers, diagnoses, clinical notes, or screenshots with patient data.',
    'Describe the workflow, product, page, expected behavior, and error wording. Do not include patient names, dates of birth, medical record numbers, diagnoses, clinical notes, or screenshots with patient data.',
    'approved', null, now(), 'seed:v1'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    1,
    'Invite a team member',
    'Add a user, assign the correct role, and confirm access.',
    'Open **Team**, select **Invite member**, choose the least-privileged role that fits the person''s work, and send the invitation.',
    'Open Team, select Invite member, choose the least-privileged role that fits the person''s work, and send the invitation.',
    'approved', null, now(), 'seed:v1'
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000003',
    1,
    'Inviting and onboarding a new user',
    'Reusable walkthrough with product-specific screen overlays.',
    null, null, 'approved', null, now(), 'seed:v1'
  ),
  (
    '30000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000004',
    1,
    'CareMetric CareBase course catalog',
    'Open the central CareMetric course catalog for governed training, assignments, quizzes, and certificates.',
    'Courses are maintained once in CareMetric CareBase and can be assigned across supported organizations. Sign in to browse the current governed catalog.',
    'Courses are maintained once in CareMetric CareBase and can be assigned across supported organizations. Sign in to browse the current governed catalog.',
    'approved', null, now(), 'seed:v1'
  )
on conflict (id) do nothing;

insert into hub.content_publications (item_id, revision_id, product_id, audience, route_pattern)
select item_id, revision_id, product_id, audience, route_pattern
from (
  values
    ('20000000-0000-4000-8000-000000000001'::uuid, '30000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, array['all']::text[], null::text),
    ('20000000-0000-4000-8000-000000000001'::uuid, '30000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000002'::uuid, array['all']::text[], null::text),
    ('20000000-0000-4000-8000-000000000001'::uuid, '30000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000003'::uuid, array['all']::text[], null::text),
    ('20000000-0000-4000-8000-000000000001'::uuid, '30000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000004'::uuid, array['all']::text[], null::text),
    ('20000000-0000-4000-8000-000000000001'::uuid, '30000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000005'::uuid, array['all']::text[], null::text),
    ('20000000-0000-4000-8000-000000000001'::uuid, '30000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000006'::uuid, array['all']::text[], null::text),
    ('20000000-0000-4000-8000-000000000002'::uuid, '30000000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, array['customer-admin']::text[], '/team/**'),
    ('20000000-0000-4000-8000-000000000002'::uuid, '30000000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-8000-000000000002'::uuid, array['customer-admin']::text[], '/team/**'),
    ('20000000-0000-4000-8000-000000000002'::uuid, '30000000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-8000-000000000003'::uuid, array['customer-admin']::text[], '/team/**'),
    ('20000000-0000-4000-8000-000000000002'::uuid, '30000000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-8000-000000000004'::uuid, array['customer-admin']::text[], '/team/**'),
    ('20000000-0000-4000-8000-000000000002'::uuid, '30000000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-8000-000000000005'::uuid, array['customer-admin']::text[], '/team/**'),
    ('20000000-0000-4000-8000-000000000002'::uuid, '30000000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-8000-000000000006'::uuid, array['customer-admin']::text[], '/team/**'),
    ('20000000-0000-4000-8000-000000000004'::uuid, '30000000-0000-4000-8000-000000000004'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, array['customer-admin','manager']::text[], null::text),
    ('20000000-0000-4000-8000-000000000004'::uuid, '30000000-0000-4000-8000-000000000004'::uuid, '00000000-0000-4000-8000-000000000006'::uuid, array['customer-admin','manager']::text[], null::text),
    ('20000000-0000-4000-8000-000000000004'::uuid, '30000000-0000-4000-8000-000000000004'::uuid, '00000000-0000-4000-8000-000000000002'::uuid, array['customer-admin','manager']::text[], null::text),
    ('20000000-0000-4000-8000-000000000004'::uuid, '30000000-0000-4000-8000-000000000004'::uuid, '00000000-0000-4000-8000-000000000003'::uuid, array['customer-admin','manager']::text[], null::text),
    ('20000000-0000-4000-8000-000000000004'::uuid, '30000000-0000-4000-8000-000000000004'::uuid, '00000000-0000-4000-8000-000000000004'::uuid, array['customer-admin','manager']::text[], null::text),
    ('20000000-0000-4000-8000-000000000004'::uuid, '30000000-0000-4000-8000-000000000004'::uuid, '00000000-0000-4000-8000-000000000005'::uuid, array['customer-admin','manager']::text[], null::text)
) as seed(item_id, revision_id, product_id, audience, route_pattern)
on conflict (item_id, product_id) do nothing;

insert into hub.course_links (content_item_id, penntrain_course_id, source_version, launch_path, duration_minutes, level, objectives)
values (
  '20000000-0000-4000-8000-000000000004',
  'catalog:caremetric-carebase',
  'PennTrain:e4737ac86af1ccdcb734cc60389730674e6c7a98',
  '/app/courses',
  null,
  null,
  array['Browse governed CareMetric training', 'Assign courses from the central catalog', 'Track quizzes and certificates in CareMetric CareBase']
)
on conflict (content_item_id) do nothing;

-- Final least-privilege content and tenant authorization contract. These
-- replacements intentionally appear after the seed so this standalone schema
-- reaches the same state as the ordered production migrations.
create or replace function private.can_view_tenant(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and (
      exists (
        select 1
        from hub.tenant_product_memberships membership
        where membership.user_id = (select auth.uid())
          and membership.tenant_id = p_tenant_id
          and membership.status = 'active'
          and membership.revoked_at is null
          and private.is_active_member(membership.tenant_id, membership.product_id)
      )
      or private.has_staff_permission('tenant.manage', null)
      or exists (
        select 1
        from hub.tenant_products entitlement
        where entitlement.tenant_id = p_tenant_id
          and (
            private.has_staff_permission('case.read', entitlement.product_id)
            or private.has_staff_permission('case.write', entitlement.product_id)
            or private.has_staff_permission('tenant.manage', entitlement.product_id)
          )
      )
    );
$$;

create or replace function private.has_active_content_audience(
  p_product_id uuid,
  p_audience text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and (not private.current_principal_requires_aal2() or private.current_session_is_aal2())
    and exists (
      select 1
      from hub.tenant_product_memberships membership
      join hub.tenant_products entitlement
        on entitlement.tenant_id = membership.tenant_id
       and entitlement.product_id = membership.product_id
      join hub.tenants tenant on tenant.id = membership.tenant_id
      join hub.products product on product.id = membership.product_id
      where membership.user_id = (select auth.uid())
        and membership.product_id = p_product_id
        and membership.status = 'active'
        and membership.revoked_at is null
        and entitlement.status = 'active'
        and tenant.status = 'active'
        and product.status <> 'retired'
        and product.support_enabled
        and (
          'all' = any(coalesce(p_audience, array[]::text[]))
          or (
            membership.role = 'tenant_admin'
            and coalesce(p_audience, array[]::text[]) && array['customer-admin', 'manager']::text[]
          )
          or (
            membership.role = 'customer'
            and 'customer' = any(coalesce(p_audience, array[]::text[]))
          )
        )
    );
$$;

create or replace function private.can_access_content_publication(
  p_item_id uuid,
  p_revision_id uuid,
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
    from hub.content_publications publication
    join hub.content_items item
      on item.id = publication.item_id
    join hub.content_revisions revision
      on revision.id = publication.revision_id
     and revision.item_id = publication.item_id
    join hub.products publication_product
      on publication_product.id = publication.product_id
    where publication.item_id = p_item_id
      and publication.revision_id = p_revision_id
      and publication.product_id = p_product_id
      and (revision.product_overlay_id is null or revision.product_overlay_id = publication.product_id)
      and (
        private.has_staff_permission('content.read', publication.product_id)
        or private.has_staff_permission('content.write', publication.product_id)
        or (
          item.status = 'published'
          and revision.review_state = 'approved'
          and publication_product.status <> 'retired'
          and publication_product.support_enabled
          and publication.published_at <= now()
          and (publication.expires_at is null or publication.expires_at > now())
          and (
            (
              item.access_level = 'public'
              and 'all' = any(coalesce(publication.audience, array[]::text[]))
            )
            or (
              item.access_level = 'customer'
              and private.has_active_content_audience(publication.product_id, publication.audience)
            )
          )
        )
      )
  );
$$;

create or replace function private.can_view_content_item(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from hub.content_items item
    where item.id = p_item_id
      and (
        private.has_staff_permission('content.read', item.owner_product_id)
        or private.has_staff_permission('content.write', item.owner_product_id)
        or exists (
          select 1
          from hub.content_publications publication
          where publication.item_id = item.id
            and private.can_access_content_publication(
              publication.item_id,
              publication.revision_id,
              publication.product_id
            )
        )
      )
  );
$$;

create or replace function private.can_view_content_revision(p_revision_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from hub.content_revisions revision
    join hub.content_items item on item.id = revision.item_id
    where revision.id = p_revision_id
      and (
        private.has_staff_permission(
          'content.read',
          coalesce(revision.product_overlay_id, item.owner_product_id)
        )
        or private.has_staff_permission(
          'content.write',
          coalesce(revision.product_overlay_id, item.owner_product_id)
        )
        or exists (
          select 1
          from hub.content_publications publication
          where publication.item_id = revision.item_id
            and publication.revision_id = revision.id
            and private.can_access_content_publication(
              publication.item_id,
              publication.revision_id,
              publication.product_id
            )
        )
      )
  );
$$;

create or replace function private.can_view_media_asset(p_asset_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from hub.media_assets media
    join hub.content_items item on item.id = media.content_item_id
    join hub.content_revisions revision
      on revision.id = media.revision_id
     and revision.item_id = media.content_item_id
    where media.id = p_asset_id
      and (
        revision.product_overlay_id is null
        or media.product_id is null
        or media.product_id = revision.product_overlay_id
      )
      and (
        private.has_staff_permission(
          'content.read',
          coalesce(media.product_id, revision.product_overlay_id, item.owner_product_id)
        )
        or private.has_staff_permission(
          'content.write',
          coalesce(media.product_id, revision.product_overlay_id, item.owner_product_id)
        )
        or exists (
          select 1
          from hub.content_publications publication
          where publication.item_id = media.content_item_id
            and publication.revision_id = media.revision_id
            and (media.product_id is null or media.product_id = publication.product_id)
            and private.can_access_content_publication(
              publication.item_id,
              publication.revision_id,
              publication.product_id
            )
            and (
              private.has_staff_permission('content.read', publication.product_id)
              or private.has_staff_permission('content.write', publication.product_id)
              or (
                media.render_status = 'ready'
                and media.data_classification = 'none'
                and (
                  (media.access_level = 'public' and item.access_level = 'public')
                  or (
                    media.access_level = 'customer'
                    and item.access_level = 'customer'
                    and private.has_active_content_audience(
                      publication.product_id,
                      publication.audience
                    )
                  )
                )
              )
            )
        )
      )
  );
$$;

revoke all on function private.can_view_tenant(uuid) from public, anon, authenticated;
revoke all on function private.has_active_content_audience(uuid, text[]) from public, anon, authenticated;
revoke all on function private.can_access_content_publication(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.can_view_content_item(uuid) from public, anon, authenticated;
revoke all on function private.can_view_content_revision(uuid) from public, anon, authenticated;
revoke all on function private.can_view_media_asset(uuid) from public, anon, authenticated;

grant execute on function private.can_view_tenant(uuid) to authenticated;
grant execute on function private.can_access_content_publication(uuid, uuid, uuid) to anon, authenticated;
grant execute on function private.can_view_content_item(uuid) to anon, authenticated;
grant execute on function private.can_view_content_revision(uuid) to anon, authenticated;
grant execute on function private.can_view_media_asset(uuid) to anon, authenticated;

drop policy if exists tenants_member_read on hub.tenants;
create policy tenants_member_read on hub.tenants
for select to authenticated
using (private.can_view_tenant(id));

drop policy if exists content_items_read on hub.content_items;
create policy content_items_read on hub.content_items
for select to anon, authenticated
using (private.can_view_content_item(id));

drop policy if exists content_revisions_read on hub.content_revisions;
create policy content_revisions_read on hub.content_revisions
for select to anon, authenticated
using (private.can_view_content_revision(id));

drop policy if exists content_publications_read on hub.content_publications;
create policy content_publications_read on hub.content_publications
for select to anon, authenticated
using (private.can_access_content_publication(item_id, revision_id, product_id));

drop policy if exists media_assets_read on hub.media_assets;
create policy media_assets_read on hub.media_assets
for select to anon, authenticated
using (private.can_view_media_asset(id));

create or replace function hub.list_published_content()
returns table (
  id uuid,
  content_key text,
  kind hub.content_kind,
  title text,
  summary text,
  body_markdown text,
  status hub.content_status,
  access_level hub.access_level,
  product_ids uuid[],
  audience text[],
  locale text,
  revision_no integer,
  source_system hub.content_source,
  route_pattern text,
  video_status text,
  course_launch_path text,
  placements jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with accessible_publications as (
    select
      publication.id as publication_id,
      publication.item_id,
      publication.revision_id,
      publication.product_id,
      publication.audience,
      publication.route_pattern
    from hub.content_publications publication
    join hub.content_items item
      on item.id = publication.item_id
    join hub.content_revisions revision
      on revision.id = publication.revision_id
     and revision.item_id = publication.item_id
    join hub.products product
      on product.id = publication.product_id
    where item.status = 'published'
      and revision.review_state = 'approved'
      and product.status <> 'retired'
      and product.support_enabled
      and (revision.product_overlay_id is null or revision.product_overlay_id = publication.product_id)
      and publication.published_at <= now()
      and (publication.expires_at is null or publication.expires_at > now())
      and private.can_access_content_publication(
        publication.item_id,
        publication.revision_id,
        publication.product_id
      )
  ),
  grouped_publications as (
    select
      publication.item_id,
      publication.revision_id,
      array_agg(distinct publication.product_id) as product_ids,
      coalesce(
        (
          select array_agg(distinct audience_value order by audience_value)
          from accessible_publications audience_publication
          cross join lateral unnest(audience_publication.audience) as audience_value
          where audience_publication.item_id = publication.item_id
            and audience_publication.revision_id = publication.revision_id
        ),
        array[]::text[]
      ) as audience,
      case
        when count(distinct publication.route_pattern)
          filter (where publication.route_pattern is not null) <= 1
        then min(publication.route_pattern)
        else null
      end as route_pattern,
      jsonb_agg(
        jsonb_build_object(
          'product_id', publication.product_id,
          'audience', publication.audience,
          'route_pattern', publication.route_pattern
        )
        order by publication.product_id
      ) as placements
    from accessible_publications publication
    group by publication.item_id, publication.revision_id
  )
  select
    revision.id,
    item.content_key,
    item.kind,
    revision.title,
    revision.summary,
    revision.body_markdown,
    item.status,
    item.access_level,
    grouped.product_ids,
    grouped.audience,
    revision.locale,
    revision.revision_no,
    item.source_system,
    grouped.route_pattern,
    media.render_status as video_status,
    course.launch_path as course_launch_path,
    grouped.placements
  from grouped_publications grouped
  join hub.content_items item on item.id = grouped.item_id
  join hub.content_revisions revision on revision.id = grouped.revision_id
  left join lateral (
    select asset.render_status
    from hub.media_assets asset
    where asset.content_item_id = grouped.item_id
      and asset.revision_id = grouped.revision_id
      and private.can_view_media_asset(asset.id)
      and exists (
        select 1
        from accessible_publications publication
        where publication.item_id = asset.content_item_id
          and publication.revision_id = asset.revision_id
          and (asset.product_id is null or asset.product_id = publication.product_id)
      )
    order by
      (asset.published_at is not null) desc,
      asset.published_at desc nulls last,
      case asset.render_status
        when 'ready' then 1
        when 'review' then 2
        when 'rendering' then 3
        when 'failed' then 4
        when 'retired' then 5
        else 6
      end,
      asset.created_at desc,
      asset.id desc
    limit 1
  ) media on true
  left join hub.course_links course on course.content_item_id = item.id
  order by revision.title;
$$;

revoke all on function hub.list_published_content() from public, anon, authenticated;
grant execute on function hub.list_published_content() to anon, authenticated;

-- Browsers consume only the sanitized content RPC; raw revision, publication,
-- course, and media-storage rows are not part of the client contract.
revoke select
on table
  hub.content_items,
  hub.content_revisions,
  hub.content_publications,
  hub.content_relations,
  hub.media_assets,
  hub.course_links,
  hub.published_content
from anon, authenticated;


-- Safe public learning metadata returned by the sanitized content RPC.
drop function if exists hub.list_published_content();

create function hub.list_published_content()
returns table (
  id uuid,
  content_key text,
  kind hub.content_kind,
  title text,
  summary text,
  body_markdown text,
  status hub.content_status,
  access_level hub.access_level,
  product_ids uuid[],
  audience text[],
  locale text,
  revision_no integer,
  source_system hub.content_source,
  route_pattern text,
  video_status text,
  course_launch_path text,
  placements jsonb,
  content_category text,
  course_duration_minutes integer,
  course_video_count integer,
  course_video_titles text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with accessible_publications as (
    select
      publication.id as publication_id,
      publication.item_id,
      publication.revision_id,
      publication.product_id,
      publication.audience,
      publication.route_pattern
    from hub.content_publications publication
    join hub.content_items item
      on item.id = publication.item_id
    join hub.content_revisions revision
      on revision.id = publication.revision_id
     and revision.item_id = publication.item_id
    join hub.products product
      on product.id = publication.product_id
    where item.status = 'published'
      and revision.review_state = 'approved'
      and product.status <> 'retired'
      and product.support_enabled
      and (revision.product_overlay_id is null or revision.product_overlay_id = publication.product_id)
      and publication.published_at <= now()
      and (publication.expires_at is null or publication.expires_at > now())
      and private.can_access_content_publication(
        publication.item_id,
        publication.revision_id,
        publication.product_id
      )
  ),
  grouped_publications as (
    select
      publication.item_id,
      publication.revision_id,
      array_agg(distinct publication.product_id) as product_ids,
      coalesce(
        (
          select array_agg(distinct audience_value order by audience_value)
          from accessible_publications audience_publication
          cross join lateral unnest(audience_publication.audience) as audience_value
          where audience_publication.item_id = publication.item_id
            and audience_publication.revision_id = publication.revision_id
        ),
        array[]::text[]
      ) as audience,
      case
        when count(distinct publication.route_pattern)
          filter (where publication.route_pattern is not null) <= 1
        then min(publication.route_pattern)
        else null
      end as route_pattern,
      jsonb_agg(
        jsonb_build_object(
          'product_id', publication.product_id,
          'audience', publication.audience,
          'route_pattern', publication.route_pattern
        )
        order by publication.product_id
      ) as placements
    from accessible_publications publication
    group by publication.item_id, publication.revision_id
  )
  select
    revision.id,
    item.content_key,
    item.kind,
    revision.title,
    revision.summary,
    revision.body_markdown,
    item.status,
    item.access_level,
    grouped.product_ids,
    grouped.audience,
    revision.locale,
    revision.revision_no,
    item.source_system,
    grouped.route_pattern,
    media.render_status as video_status,
    course.launch_path as course_launch_path,
    grouped.placements,
    nullif(btrim(revision.variables ->> 'category'), '') as content_category,
    course.duration_minutes as course_duration_minutes,
    case
      when coalesce(revision.variables ->> 'video_count', '') ~ '^[0-9]{1,6}$'
      then (revision.variables ->> 'video_count')::integer
      else null
    end as course_video_count,
    case
      when jsonb_typeof(revision.variables -> 'video_titles') = 'array'
      then array(
        select left(video_title.value, 180)
        from jsonb_array_elements_text(revision.variables -> 'video_titles')
          with ordinality as video_title(value, position)
        where video_title.position <= 100
        order by video_title.position
      )
      else array[]::text[]
    end as course_video_titles
  from grouped_publications grouped
  join hub.content_items item
    on item.id = grouped.item_id
  join hub.content_revisions revision
    on revision.id = grouped.revision_id
  left join lateral (
    select asset.render_status
    from hub.media_assets asset
    where asset.content_item_id = grouped.item_id
      and asset.revision_id = grouped.revision_id
      and private.can_view_media_asset(asset.id)
      and exists (
        select 1
        from accessible_publications publication
        where publication.item_id = asset.content_item_id
          and publication.revision_id = asset.revision_id
          and (asset.product_id is null or asset.product_id = publication.product_id)
      )
    order by
      (asset.published_at is not null) desc,
      asset.published_at desc nulls last,
      case asset.render_status
        when 'ready' then 1
        when 'review' then 2
        when 'rendering' then 3
        when 'failed' then 4
        when 'retired' then 5
        else 6
      end,
      asset.created_at desc,
      asset.id desc
    limit 1
  ) media on true
  left join hub.course_links course
    on course.content_item_id = item.id
  order by revision.title;
$$;

revoke all on function hub.list_published_content()
from public, anon, authenticated;
grant execute on function hub.list_published_content()
to anon, authenticated;

-- The Hub owns new course revisions, delivery, grading, and completion records.
-- Legacy course_links remain provenance; no source learning history is deleted.
create table private.learning_courses (
  item_id uuid primary key references hub.content_items(id),
  draft jsonb not null,
  draft_version integer not null default 1,
  published_version_id uuid,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
create table private.learning_versions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references private.learning_courses(item_id),
  revision_id uuid not null references hub.content_revisions(id),
  document jsonb not null,
  published_by uuid references auth.users(id),
  published_at timestamptz not null default now(),
  unique (item_id, id)
);
alter table private.learning_courses add constraint learning_published_version_fk
  foreign key (item_id, published_version_id) references private.learning_versions(item_id, id);
create table private.learning_enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  version_id uuid not null references private.learning_versions(id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  certificate_id uuid unique,
  certificate_name text,
  unique (user_id, version_id),
  check ((completed_at is null) = (certificate_id is null)),
  check ((completed_at is null) = (certificate_name is null))
);
create table private.learning_unit_progress (
  enrollment_id uuid not null references private.learning_enrollments(id),
  unit_id uuid not null,
  completed_at timestamptz,
  attempt_count integer not null default 0,
  best_score integer check (best_score between 0 and 100),
  primary key (enrollment_id, unit_id)
);
create table private.learning_submissions (
  enrollment_id uuid not null references private.learning_enrollments(id),
  request_key uuid not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (enrollment_id, request_key)
);
create index learning_versions_revision_idx on private.learning_versions(revision_id);
create index learning_enrollments_version_idx on private.learning_enrollments(version_id);
create index learning_versions_publisher_idx on private.learning_versions(published_by);
create index learning_courses_editor_idx on private.learning_courses(updated_by);
alter table private.learning_courses enable row level security;
alter table private.learning_versions enable row level security;
alter table private.learning_enrollments enable row level security;
alter table private.learning_unit_progress enable row level security;
alter table private.learning_submissions enable row level security;
revoke all on private.learning_courses, private.learning_versions, private.learning_enrollments,
  private.learning_unit_progress, private.learning_submissions from public, anon, authenticated;

create table private.learning_media (
  id uuid primary key,
  title text not null check (char_length(title) between 2 and 180),
  storage_key text not null unique,
  caption_storage_key text not null unique,
  transcript_storage_key text not null unique,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  uploaded_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index learning_media_uploader_idx on private.learning_media(uploaded_by);
alter table private.learning_media enable row level security;
revoke all on private.learning_media from public,anon,authenticated;

create function private.require_learning_user() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.current_user_is_usable()
    or (private.current_principal_requires_aal2() and not private.current_session_is_aal2()) then
    raise exception 'Sign in with the required verification to continue.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;
create function private.require_learning_editor() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_learning_user();
  -- Shared courses require portfolio-wide content permission. A permission
  -- scoped to one product cannot publish to another product through the Hub.
  if not private.has_staff_permission('content.write', null) then
    raise exception 'Shared-course editor access required.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

create function private.validate_learning_document(p_doc jsonb, p_publishing boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  unit jsonb; question jsonb; option jsonb; unit_ids uuid[] := '{}'; question_ids uuid[];
  option_ids uuid[]; unit_id uuid; question_id uuid; option_id uuid; product_id uuid;
  products uuid[] := '{}'; unit_type text; media private.learning_media%rowtype;
begin
  if p_doc is null or jsonb_typeof(p_doc) <> 'object' or octet_length(p_doc::text) > 1500000 then
    raise exception 'Course document is invalid or too large.' using errcode = '22023';
  end if;
  if coalesce(char_length(btrim(p_doc->>'title')), 0) not between 2 and 180
    or coalesce(char_length(p_doc->>'summary'), 0) > 500
    or coalesce(char_length(p_doc->>'category'), 0) > 100
    or coalesce(char_length(p_doc->>'overview'),0)>60000
    or coalesce(p_doc->>'accessLevel', '') not in ('public', 'customer', 'staff')
    or coalesce(p_doc->>'durationMinutes', '') !~ '^[0-9]{1,4}$'
    or (p_doc->>'durationMinutes')::integer not between 1 and 1440 then
    raise exception 'Complete the course title, summary, access, and duration.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_doc->'productIds') is distinct from 'array'
    or jsonb_array_length(p_doc->'productIds') not between 1 and 6 then
    raise exception 'Choose at least one registered product.' using errcode = '22023';
  end if;
  for product_id in select value::uuid from jsonb_array_elements_text(p_doc->'productIds') loop
    if product_id = any(products) or not exists (
      select 1 from hub.products p where p.id = product_id and p.status <> 'retired'
        and p.slug in ('carebase','pennsync','breathe','caremetric-emr','caremetric-go','caremetric-intel')
    ) then raise exception 'Course product is invalid or duplicated.' using errcode = '22023'; end if;
    products := array_append(products, product_id);
  end loop;
  if jsonb_typeof(p_doc->'units') is distinct from 'array'
    or jsonb_array_length(p_doc->'units') not between 1 and 150 then
    raise exception 'A course needs between 1 and 150 learning units.' using errcode = '22023';
  end if;
  for unit in select value from jsonb_array_elements(p_doc->'units') loop
    unit_id := (unit->>'id')::uuid;
    unit_type := unit->>'type';
    if unit_id is null or unit_id = any(unit_ids)
      or coalesce(char_length(btrim(unit->>'title')), 0) not between 2 and 180
      or coalesce(unit_type, '') not in ('text','video','quiz','attestation') then
      raise exception 'Learning unit is invalid or duplicated.' using errcode = '22023';
    end if;
    unit_ids := array_append(unit_ids, unit_id);
    if unit_type in ('text','attestation')
      and coalesce(char_length(btrim(unit->>'body')), 0) not between 1 and 60000 then
      raise exception 'A lesson or attestation needs readable content.' using errcode = '22023';
    end if;
    if unit_type = 'video' then
      if coalesce(char_length(btrim(unit->>'body')), 0) not between 1 and 60000 then
        raise exception 'Video lessons require a transcript.' using errcode = '22023';
      end if;
      if p_publishing then
        select * into media from private.learning_media where id = (unit->>'mediaAssetId')::uuid;
        if not found then
          raise exception 'Video requires approved central media, checksum, captions, and transcript.' using errcode = '22023';
        end if;
      end if;
    end if;
    if unit_type = 'quiz' then
      if coalesce(unit->>'passingScore', '') !~ '^[0-9]{1,3}$'
        or (unit->>'passingScore')::integer not between 1 and 100
        or (unit->>'maxAttempts' is not null and
          (unit->>'maxAttempts' !~ '^[0-9]{1,2}$' or (unit->>'maxAttempts')::integer not between 1 and 10))
        or jsonb_typeof(unit->'questions') is distinct from 'array'
        or jsonb_array_length(unit->'questions') not between 1 and 100 then
        raise exception 'Complete quiz questions, passing score, and attempt limit.' using errcode = '22023';
      end if;
      question_ids := '{}';
      for question in select value from jsonb_array_elements(unit->'questions') loop
        question_id := (question->>'id')::uuid;
        if question_id is null or question_id = any(question_ids)
          or coalesce(char_length(btrim(question->>'prompt')), 0) not between 2 and 3000
          or coalesce(question->>'points','1') !~ '^[0-9]{1,3}$'
          or coalesce((question->>'points')::integer,1) not between 1 and 100
          or jsonb_typeof(question->'options') is distinct from 'array'
          or jsonb_array_length(question->'options') not between 2 and 8 then
          raise exception 'Quiz question is incomplete or duplicated.' using errcode = '22023';
        end if;
        question_ids := array_append(question_ids, question_id);
        option_ids := '{}';
        for option in select value from jsonb_array_elements(question->'options') loop
          option_id := (option->>'id')::uuid;
          if option_id is null or option_id = any(option_ids)
            or coalesce(char_length(btrim(option->>'text')), 0) not between 1 and 2000 then
            raise exception 'Quiz answer option is invalid or duplicated.' using errcode = '22023';
          end if;
          option_ids := array_append(option_ids, option_id);
        end loop;
        if not coalesce((question->>'correctOptionId')::uuid = any(option_ids), false) then
          raise exception 'Choose exactly one valid correct answer.' using errcode = '22023';
        end if;
      end loop;
    end if;
  end loop;
end;
$$;

-- Explicit projection, never JSON minus a denylist: future author-only fields
-- must not accidentally become part of the learner API.
create function private.learning_public_document(p_doc jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'title', p_doc->>'title', 'summary', p_doc->>'summary', 'category', p_doc->>'category',
    'overview', coalesce(p_doc->>'overview',''), 'durationMinutes', p_doc->'durationMinutes', 'accessLevel', p_doc->>'accessLevel',
    'productIds', p_doc->'productIds',
    'units', (select jsonb_agg(jsonb_build_object(
      'id', u.value->>'id', 'type', u.value->>'type', 'title', u.value->>'title',
      'body', coalesce(u.value->>'body',''),
      'mediaAssetId', case when u.value->>'type' = 'video' then u.value->>'mediaAssetId' else null end,
      'passingScore', u.value->'passingScore', 'maxAttempts', u.value->'maxAttempts',
      'questions', case when u.value->>'type' = 'quiz' then (
        select jsonb_agg(jsonb_build_object('id', q.value->>'id', 'prompt', q.value->>'prompt', 'points', coalesce((q.value->>'points')::integer,1),
          'options', (select jsonb_agg(jsonb_build_object('id', o.value->>'id', 'text', o.value->>'text') order by o.ordinality)
            from jsonb_array_elements(q.value->'options') with ordinality o)
        ) order by q.ordinality) from jsonb_array_elements(u.value->'questions') with ordinality q
      ) else null end
    ) order by u.ordinality) from jsonb_array_elements(p_doc->'units') with ordinality u)
  );
$$;

create function hub.get_learning_editor_access() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_staff_permission('content.write', null);
$$;

create function hub.list_learning_drafts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_learning_editor();
  return coalesce((select jsonb_agg(jsonb_build_object('itemId', c.item_id,
    'title', c.draft->>'title', 'draftVersion', c.draft_version,
    'published', c.published_version_id is not null, 'updatedAt', c.updated_at)
    order by c.updated_at desc) from private.learning_courses c), '[]'::jsonb);
end;
$$;

create function hub.get_learning_draft(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare course private.learning_courses%rowtype;
begin
  perform private.require_learning_editor();
  select * into course from private.learning_courses where item_id = p_item_id;
  if not found then raise exception 'Course draft unavailable.' using errcode = 'P0002'; end if;
  return jsonb_build_object('itemId', course.item_id, 'draftVersion', course.draft_version,
    'document', course.draft, 'published', course.published_version_id is not null);
end;
$$;

create function hub.save_learning_draft(p_item_id uuid, p_document jsonb, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare editor uuid; v_item_id uuid; course private.learning_courses%rowtype;
begin
  editor := private.require_learning_editor();
  perform private.validate_learning_document(p_document);
  if p_item_id is null or p_expected_version = 0 then
    if p_expected_version is distinct from 0 then raise exception 'Invalid new-draft version.' using errcode = '22023'; end if;
    v_item_id := coalesce(p_item_id,gen_random_uuid());
    insert into hub.content_items(id,content_key,kind,access_level,created_by)
      values(v_item_id,'hub.course.' || v_item_id::text,'course',(p_document->>'accessLevel')::hub.access_level,editor)
      on conflict(id) do nothing;
    if not exists(select 1 from hub.content_items i where i.id=v_item_id and i.created_by=editor and i.kind='course') then
      raise exception 'Course creation key is unavailable.' using errcode='40001';
    end if;
    insert into private.learning_courses(item_id,draft,updated_by) values(v_item_id,p_document,editor)
      on conflict on constraint learning_courses_pkey do nothing;
    if not exists(select 1 from private.learning_courses c where c.item_id=v_item_id
      and c.draft_version=1 and c.draft=p_document) then
      raise exception 'This course was already saved. Reload it before editing.' using errcode='40001';
    end if;
  else
    select * into course from private.learning_courses c where c.item_id = p_item_id for update;
    if not found then raise exception 'Course draft unavailable.' using errcode = 'P0002'; end if;
    if course.draft_version is distinct from p_expected_version then
      raise exception 'This draft changed. Reload it before saving.' using errcode = '40001';
    end if;
    v_item_id := p_item_id;
    update private.learning_courses c set draft = p_document, draft_version = c.draft_version + 1,
      updated_by = editor, updated_at = now() where c.item_id = p_item_id;
  end if;
  return hub.get_learning_draft(v_item_id);
end;
$$;

create function hub.publish_learning_course(p_item_id uuid, p_expected_version integer, p_reviewed boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  editor uuid; course private.learning_courses%rowtype; v_revision_id uuid := gen_random_uuid();
  v_version_id uuid := gen_random_uuid(); revision_number integer; v_product_id uuid;
begin
  editor := private.require_learning_editor();
  if p_reviewed is distinct from true then
    raise exception 'Review the course for accuracy and confirm it contains no private data before publishing.' using errcode = '22023';
  end if;
  select * into course from private.learning_courses where item_id = p_item_id for update;
  if not found then raise exception 'Course draft unavailable.' using errcode = 'P0002'; end if;
  if course.draft_version is distinct from p_expected_version then
    raise exception 'This draft changed. Reload it before publishing.' using errcode = '40001';
  end if;
  perform private.validate_learning_document(course.draft, true);
  -- A retry of publishing the same reviewed draft returns its existing version.
  if exists (select 1 from private.learning_versions v where v.id = course.published_version_id and v.document = course.draft) then
    return jsonb_build_object('itemId',p_item_id,'versionId',course.published_version_id);
  end if;
  select coalesce(max(revision_no),0) + 1 into revision_number from hub.content_revisions where item_id = p_item_id;
  insert into hub.content_revisions(id,item_id,revision_no,title,summary,variables,review_state,created_by,approved_by,approved_at)
    values(v_revision_id,p_item_id,revision_number,course.draft->>'title',coalesce(course.draft->>'summary',''),
      jsonb_build_object('content_category',course.draft->>'category','course_duration_minutes',course.draft->'durationMinutes'),
      'approved',editor,editor,now());
  insert into private.learning_versions(id,item_id,revision_id,document,published_by)
    values(v_version_id,p_item_id,v_revision_id,course.draft,editor);
  update private.learning_courses set published_version_id = v_version_id where item_id = p_item_id;
  update hub.content_items set status='published', source_system='support_hub',
    access_level=(course.draft->>'accessLevel')::hub.access_level,retired_at=null where id=p_item_id;
  -- Expire removed placements; keep historical publications and revisions.
  update hub.content_publications set expires_at = clock_timestamp() where item_id = p_item_id
    and product_id not in (select value::uuid from jsonb_array_elements_text(course.draft->'productIds'));
  for v_product_id in select value::uuid from jsonb_array_elements_text(course.draft->'productIds') loop
    insert into hub.content_publications(item_id,revision_id,product_id,published_by)
      values(p_item_id,v_revision_id,v_product_id,editor)
      on conflict(item_id,product_id) do update set revision_id=excluded.revision_id,
        published_at=now(),expires_at=null,published_by=excluded.published_by;
  end loop;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(editor,'learning.course.published','content_item',p_item_id,
      jsonb_build_object('version_id',v_version_id,'revision_no',revision_number));
  return jsonb_build_object('itemId',p_item_id,'versionId',v_version_id);
end;
$$;

create function hub.list_learning_catalog() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('itemId',c.item_id,'versionId',v.id,
    'title',v.document->>'title','summary',v.document->>'summary','category',v.document->>'category',
    'durationMinutes',v.document->'durationMinutes','productIds',v.document->'productIds',
    'unitCount',jsonb_array_length(v.document->'units')) order by v.document->>'title'), '[]'::jsonb)
  from private.learning_courses c join private.learning_versions v on v.id=c.published_version_id
  join hub.content_items i on i.id=c.item_id
  where i.status='published' and private.can_view_content_item(c.item_id);
$$;

create function hub.enroll_learning_course(p_item_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare learner uuid; v_version_id uuid; enrollment_id uuid;
begin
  learner := private.require_learning_user();
  select c.published_version_id into v_version_id from private.learning_courses c
    join hub.content_items i on i.id=c.item_id where c.item_id=p_item_id and i.status='published'
      and private.can_view_content_item(c.item_id);
  if v_version_id is null then raise exception 'Course unavailable.' using errcode='42501'; end if;
  insert into private.learning_enrollments(user_id,version_id) values(learner,v_version_id)
    on conflict(user_id,version_id) do nothing;
  select e.id into enrollment_id from private.learning_enrollments e where e.user_id=learner and e.version_id=v_version_id;
  return enrollment_id;
end;
$$;

create function hub.get_learning_course(p_item_id uuid, p_enrollment_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare learner uuid; version private.learning_versions%rowtype; enrollment private.learning_enrollments%rowtype;
begin
  learner := private.require_learning_user();
  if not private.can_view_content_item(p_item_id) or not exists(
    select 1 from hub.content_items where id=p_item_id and status='published'
  ) then raise exception 'Course unavailable.' using errcode='42501'; end if;
  if p_enrollment_id is not null then
    select e.* into enrollment from private.learning_enrollments e join private.learning_versions v on v.id=e.version_id
      where e.id=p_enrollment_id and e.user_id=learner and v.item_id=p_item_id;
    if not found then raise exception 'Enrollment unavailable.' using errcode='42501'; end if;
    select * into version from private.learning_versions where id=enrollment.version_id;
  else
    select v.* into version from private.learning_versions v join private.learning_courses c on c.published_version_id=v.id
      where c.item_id=p_item_id;
    if not found then raise exception 'Course unavailable.' using errcode='42501'; end if;
    select * into enrollment from private.learning_enrollments e where e.user_id=learner and e.version_id=version.id;
  end if;
  return jsonb_build_object('itemId',p_item_id,'versionId',version.id,
    'document',private.learning_public_document(version.document),
    'enrollmentId',enrollment.id,'completedAt',enrollment.completed_at,'certificateId',enrollment.certificate_id,
    'progress',coalesce((select jsonb_agg(jsonb_build_object('unitId',unit_id,'completedAt',completed_at,
      'attemptCount',attempt_count,'bestScore',best_score)) from private.learning_unit_progress where enrollment_id=enrollment.id),'[]'::jsonb));
end;
$$;

create function hub.submit_learning_unit(p_enrollment_id uuid,p_unit_id uuid,p_answers jsonb,p_attested boolean,p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  learner uuid; enrollment private.learning_enrollments%rowtype; version private.learning_versions%rowtype;
  progress private.learning_unit_progress%rowtype; prior private.learning_submissions%rowtype;
  unit jsonb; question jsonb; request_hash text; score integer; correct integer:=0; count_questions integer; total_points integer := 0; question_points integer;
  passed boolean; result jsonb; pending integer;
begin
  learner := private.require_learning_user();
  if p_request_key is null or p_unit_id is null or p_answers is null
    or jsonb_typeof(p_answers)<>'object' or octet_length(p_answers::text)>20000 then
    raise exception 'Invalid learning submission.' using errcode='22023';
  end if;
  select * into enrollment from private.learning_enrollments where id=p_enrollment_id and user_id=learner for update;
  if not found then raise exception 'Enrollment unavailable.' using errcode='42501'; end if;
  select * into version from private.learning_versions where id=enrollment.version_id;
  if not private.can_view_content_item(version.item_id) or not exists(
    select 1 from hub.content_items where id=version.item_id and status='published'
  ) then raise exception 'Course access unavailable.' using errcode='42501'; end if;
  request_hash := encode(extensions.digest(jsonb_build_object('unit',p_unit_id,'answers',p_answers,'attested',p_attested)::text,'sha256'),'hex');
  select * into prior from private.learning_submissions where enrollment_id=p_enrollment_id and request_key=p_request_key;
  if found then
    if prior.request_hash<>request_hash then raise exception 'Submission key already used for different content.' using errcode='22023'; end if;
    return prior.result;
  end if;
  select value into unit from jsonb_array_elements(version.document->'units') where value->>'id'=p_unit_id::text;
  if unit is null then raise exception 'Learning unit unavailable.' using errcode='22023'; end if;
  if enrollment.completed_at is not null then raise exception 'Course is already completed.' using errcode='22023'; end if;
  select * into progress from private.learning_unit_progress where enrollment_id=p_enrollment_id and unit_id=p_unit_id;
  if progress.completed_at is not null then raise exception 'Learning unit is already completed.' using errcode='22023'; end if;
  if unit->>'type'='quiz' then
    if coalesce(progress.attempt_count,0)>=(unit->>'maxAttempts')::integer then
      raise exception 'Quiz attempt limit reached. Contact your educator.' using errcode='22023';
    end if;
    count_questions := jsonb_array_length(unit->'questions');
    if (select count(*) from jsonb_object_keys(p_answers))<>count_questions then
      raise exception 'Answer every quiz question exactly once.' using errcode='22023';
    end if;
    for question in select value from jsonb_array_elements(unit->'questions') loop
      if jsonb_typeof(p_answers->(question->>'id')) is distinct from 'string'
        or not exists(select 1 from jsonb_array_elements(question->'options') o
          where o->>'id'=p_answers->>(question->>'id')) then
        raise exception 'Quiz answer is not a valid option.' using errcode='22023';
      end if;
      question_points := coalesce((question->>'points')::integer,1);
      total_points := total_points + question_points;
      if p_answers->>(question->>'id')=question->>'correctOptionId' then correct:=correct+question_points; end if;
    end loop;
    score := floor(100.0*correct/total_points);
    passed := score >= (unit->>'passingScore')::integer;
  else
    if p_attested is distinct from true or p_answers<>'{}'::jsonb then
      raise exception 'Confirm that you completed this lesson.' using errcode='22023';
    end if;
    passed := true;
  end if;
  insert into private.learning_unit_progress(enrollment_id,unit_id,completed_at,attempt_count,best_score)
    values(p_enrollment_id,p_unit_id,case when passed then now() end,1,score)
    on conflict(enrollment_id,unit_id) do update set completed_at=excluded.completed_at,
      attempt_count=private.learning_unit_progress.attempt_count+1,
      best_score=greatest(private.learning_unit_progress.best_score,excluded.best_score);
  select count(*) into pending from jsonb_array_elements(version.document->'units') u
    where not exists(select 1 from private.learning_unit_progress p where p.enrollment_id=p_enrollment_id
      and p.unit_id=(u->>'id')::uuid and p.completed_at is not null);
  if pending=0 then
    update private.learning_enrollments set completed_at=now(),certificate_id=gen_random_uuid(),
      certificate_name=(select display_name from hub.profiles where id=learner)
      where id=p_enrollment_id returning * into enrollment;
    insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
      values(learner,'learning.course.completed','learning_enrollment',p_enrollment_id,
        jsonb_build_object('version_id',version.id));
  end if;
  result:=jsonb_build_object('passed',passed,'score',score,'attemptCount',coalesce(progress.attempt_count,0)+1,
    'completedAt',enrollment.completed_at,'certificateId',enrollment.certificate_id);
  insert into private.learning_submissions(enrollment_id,request_key,request_hash,result)
    values(p_enrollment_id,p_request_key,request_hash,result);
  return result;
end;
$$;

create function hub.list_my_learning() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare learner uuid;
begin
  learner := private.require_learning_user();
  return coalesce((select jsonb_agg(jsonb_build_object('enrollmentId',e.id,'itemId',v.item_id,
    'title',v.document->>'title','versionId',v.id,'startedAt',e.started_at,'completedAt',e.completed_at,
    'certificateId',e.certificate_id,'durationMinutes',v.document->'durationMinutes',
    'totalUnits',jsonb_array_length(v.document->'units'),'completedUnits',
    (select count(*) from private.learning_unit_progress p where p.enrollment_id=e.id and p.completed_at is not null))
    order by e.started_at desc) from private.learning_enrollments e join private.learning_versions v on v.id=e.version_id
    where e.user_id=learner),'[]'::jsonb);
end;
$$;

create function hub.get_learning_certificate(p_enrollment_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare learner uuid; result jsonb;
begin
  learner := private.require_learning_user();
  select jsonb_build_object('certificateId',e.certificate_id,'enrollmentId',e.id,
    'learnerName',e.certificate_name,'courseTitle',v.document->>'title','completedAt',e.completed_at,
    'durationMinutes',v.document->'durationMinutes','versionId',v.id)
    into result from private.learning_enrollments e join private.learning_versions v on v.id=e.version_id
    where e.id=p_enrollment_id and e.user_id=learner and e.completed_at is not null;
  if result is null then raise exception 'Certificate unavailable.' using errcode='42501'; end if;
  return result;
end;
$$;

revoke all on function private.require_learning_user(), private.require_learning_editor(),
  private.validate_learning_document(jsonb,boolean),private.learning_public_document(jsonb) from public,anon,authenticated;
revoke all on function hub.get_learning_editor_access(),hub.list_learning_drafts(),hub.get_learning_draft(uuid),
  hub.save_learning_draft(uuid,jsonb,integer),hub.publish_learning_course(uuid,integer,boolean),
  hub.list_learning_catalog(),hub.enroll_learning_course(uuid),hub.get_learning_course(uuid,uuid),
  hub.submit_learning_unit(uuid,uuid,jsonb,boolean,uuid),hub.list_my_learning(),hub.get_learning_certificate(uuid)
  from public,anon,authenticated;
grant execute on function hub.list_learning_catalog() to anon,authenticated;
grant execute on function hub.get_learning_editor_access(),hub.list_learning_drafts(),hub.get_learning_draft(uuid),
  hub.save_learning_draft(uuid,jsonb,integer),hub.publish_learning_course(uuid,integer,boolean),
  hub.enroll_learning_course(uuid),hub.get_learning_course(uuid,uuid),
  hub.submit_learning_unit(uuid,uuid,jsonb,boolean,uuid),hub.list_my_learning(),hub.get_learning_certificate(uuid)
  to authenticated;
-- Media is immutable and private. Products never hold provider credentials.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('hub-learning','hub-learning',false,268435456,array['video/mp4','text/vtt','text/plain']);

create function private.can_upload_learning_object(p_name text) returns boolean
language sql stable security definer set search_path='' as $$
  select private.has_staff_permission('content.write',null)
    and p_name ~ '^learning/[0-9a-f-]{36}/(video.mp4|captions.vtt|transcript.txt)$';
$$;
create function private.can_read_learning_object(p_name text) returns boolean
language sql stable security definer set search_path='' as $$
  select private.current_user_is_usable()
    and (not private.current_principal_requires_aal2() or private.current_session_is_aal2())
    and (private.has_staff_permission('content.write',null) or exists(
      select 1 from private.learning_media m
      join private.learning_versions v on exists(
        select 1 from jsonb_array_elements(v.document->'units') u where u->>'mediaAssetId'=m.id::text and u->>'type'='video')
      join private.learning_enrollments e on e.version_id=v.id and e.user_id=auth.uid()
      join hub.content_items i on i.id=v.item_id and i.status='published'
      where p_name in (m.storage_key,m.caption_storage_key,m.transcript_storage_key)
        and private.can_view_content_item(v.item_id)
    ));
$$;
revoke all on function private.can_upload_learning_object(text),private.can_read_learning_object(text) from public,anon,authenticated;
grant execute on function private.can_upload_learning_object(text),private.can_read_learning_object(text) to authenticated;
create policy learning_media_upload on storage.objects for insert to authenticated
  with check(bucket_id='hub-learning' and private.can_upload_learning_object(name));
create policy learning_media_read on storage.objects for select to authenticated
  using(bucket_id='hub-learning' and private.can_read_learning_object(name));

create function hub.register_learning_media(p_id uuid,p_title text,p_sha256 text,p_reviewed boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare editor uuid; prefix text;
begin
  editor:=private.require_learning_editor();
  if p_id is null or p_reviewed is distinct from true or coalesce(p_sha256,'') !~ '^[a-f0-9]{64}$'
    or coalesce(char_length(btrim(p_title)),0) not between 2 and 180 then
    raise exception 'Review the video, captions, transcript, and confirm there is no private data.' using errcode='22023';
  end if;
  prefix:='learning/'||p_id::text||'/';
  if (select count(*) from storage.objects where bucket_id='hub-learning'
    and name in (prefix||'video.mp4',prefix||'captions.vtt',prefix||'transcript.txt')
    and (metadata->>'size')::bigint>0)<>3 then
    raise exception 'Upload all three media files before approval.' using errcode='22023';
  end if;
  insert into private.learning_media(id,title,storage_key,caption_storage_key,transcript_storage_key,sha256,uploaded_by)
    values(p_id,p_title,prefix||'video.mp4',prefix||'captions.vtt',prefix||'transcript.txt',p_sha256,editor);
  insert into private.audit_events(actor_id,action,entity_type,entity_id)
    values(editor,'learning.media.approved','learning_media',p_id);
  return p_id;
end;
$$;
create function hub.list_learning_media() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.require_learning_editor();
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'title',title) order by created_at desc)
    from private.learning_media),'[]'::jsonb);
end;
$$;
create function hub.get_learning_media_paths(p_asset_id uuid,p_enrollment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare learner uuid; media private.learning_media%rowtype;
begin
  learner:=private.require_learning_user();
  select m.* into media from private.learning_media m where m.id=p_asset_id and exists(
    select 1 from private.learning_enrollments e join private.learning_versions v on v.id=e.version_id
    join hub.content_items i on i.id=v.item_id and i.status='published'
    where e.id=p_enrollment_id and e.user_id=learner and private.can_view_content_item(v.item_id)
      and exists(select 1 from jsonb_array_elements(v.document->'units') u where u->>'mediaAssetId'=p_asset_id::text and u->>'type'='video')
  );
  if not found then raise exception 'Video unavailable.' using errcode='42501'; end if;
  return jsonb_build_object('video',media.storage_key,'captions',media.caption_storage_key);
end;
$$;
revoke all on function hub.register_learning_media(uuid,text,text,boolean),hub.list_learning_media(),hub.get_learning_media_paths(uuid,uuid) from public,anon,authenticated;
grant execute on function hub.register_learning_media(uuid,text,text,boolean),hub.list_learning_media(),hub.get_learning_media_paths(uuid,uuid) to authenticated;


create table private.learning_imports (
  source_course_id uuid primary key,
  source_version_id uuid not null,
  document_sha256 text not null,
  item_id uuid not null unique references private.learning_courses(item_id),
  imported_at timestamptz not null default now()
);
alter table private.learning_imports enable row level security;
revoke all on private.learning_imports from public,anon,authenticated;

-- Import existing catalog items as drafts without changing live catalog links.
-- Repeated snapshots cannot overwrite either reviewed work or another source revision.
create function hub.import_learning_draft(p_source_course_id uuid,p_source_version_id uuid,p_document jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare editor uuid; v_item_id uuid; v_hash text; prior private.learning_imports%rowtype;
begin
  editor:=private.require_learning_editor();
  if p_source_course_id is null or p_source_version_id is null then
    raise exception 'Source course and revision are required.' using errcode='22023';
  end if;
  perform private.validate_learning_document(p_document);
  select l.content_item_id into v_item_id from hub.course_links l
    join hub.content_items i on i.id=l.content_item_id
    where l.penntrain_course_id=p_source_course_id::text and i.kind='course'
    for update of i;
  if not found then raise exception 'Source course is not registered in the central catalog.' using errcode='22023'; end if;
  v_hash:=encode(extensions.digest(p_document::text,'sha256'),'hex');
  select * into prior from private.learning_imports where source_course_id=p_source_course_id;
  if found then
    if prior.source_version_id<>p_source_version_id or prior.document_sha256<>v_hash then
      raise exception 'This course was already imported. Review revisions in the course editor.' using errcode='40001';
    end if;
    return hub.get_learning_draft(prior.item_id);
  end if;
  insert into private.learning_courses(item_id,draft,updated_by) values(v_item_id,p_document,editor);
  insert into private.learning_imports(source_course_id,source_version_id,document_sha256,item_id)
    values(p_source_course_id,p_source_version_id,v_hash,v_item_id);
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(editor,'learning.course.imported','content_item',v_item_id,jsonb_build_object('source_version_id',p_source_version_id));
  return hub.get_learning_draft(v_item_id);
end;
$$;
revoke all on function hub.import_learning_draft(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function hub.import_learning_draft(uuid,uuid,jsonb) to authenticated;
