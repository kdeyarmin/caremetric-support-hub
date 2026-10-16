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

-- Install this contract only after the frontend's required RPC fixes exist.
-- The endpoint is public release metadata; it does not read application data.
do $$
begin
  if position('''memberships''' in pg_get_functiondef('hub.get_support_actor_context()'::regprocedure)) = 0
    or position('assignee.deleted_at' in pg_get_functiondef('hub.update_support_case(uuid,hub.case_status,hub.case_priority,uuid,boolean)'::regprocedure)) = 0 then
    raise exception 'Apply actor-membership and safe-assignee migrations first';
  end if;
end;
$$;

create or replace function hub.get_backend_contract()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object('api_version', 1);
$$;

revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;

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
  last_quiz bigint; last_lesson bigint;
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
  -- Learners read or watch every lesson, pass a graded post-test, then receive
  -- the certificate. Drafts may be incomplete; a publication may not.
  if p_publishing then
    select max(u.position) filter (where u.value->>'type' = 'quiz'),
      max(u.position) filter (where u.value->>'type' in ('text','video'))
      into last_quiz, last_lesson
      from jsonb_array_elements(p_doc->'units') with ordinality u(value, position);
    -- A quiz-only course has no lesson to test, and NULL > x is not true, so both are explicit.
    if last_quiz is null or last_lesson is null or last_lesson > last_quiz then
      raise exception 'End the course with a graded post-test after the last lesson.' using errcode = '22023';
    end if;
  end if;
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
  -- An import preserves the source catalog identity; publishing that identity
  -- would redirect existing learners away from CareBase. Keep the source
  -- runtime until a reviewed bridge preserves quiz behavior, renewal/credit
  -- reporting, and completion evidence. Draft edits do not authorize cutover.
  if exists (select 1 from hub.course_links where content_item_id = p_item_id) then
    raise exception 'Imported CareBase courses remain drafts until quiz, credit, and completion reporting are connected. Continue using the existing CareBase course.' using errcode = '55000';
  end if;
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
  passed boolean; result jsonb; pending integer; unit_position bigint;
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
  -- Units open in course order, so the post-test follows every lesson.
  select u.position into unit_position from jsonb_array_elements(version.document->'units') with ordinality u(value,position)
    where u.value->>'id'=p_unit_id::text;
  if exists(select 1 from jsonb_array_elements(version.document->'units') with ordinality u(value,position)
    where u.position<unit_position and not exists(select 1 from private.learning_unit_progress p
      where p.enrollment_id=p_enrollment_id and p.unit_id=(u.value->>'id')::uuid and p.completed_at is not null)) then
    raise exception 'Complete the earlier lessons in order before continuing.' using errcode='22023';
  end if;
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
    'durationMinutes',v.document->'durationMinutes','versionId',v.id,
    'finalScore',post_test.best_score,'passingScore',(post_test.unit->>'passingScore')::integer)
    into result from private.learning_enrollments e join private.learning_versions v on v.id=e.version_id
    -- The certificate reports the best score on the course's final post-test.
    left join lateral (select u.value as unit,p.best_score from jsonb_array_elements(v.document->'units') with ordinality u(value,position)
      left join private.learning_unit_progress p on p.enrollment_id=e.id and p.unit_id=(u.value->>'id')::uuid
      where u.value->>'type'='quiz' order by u.position desc limit 1) post_test on true
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

-- Delegated app reads require a current Hub session and portfolio-wide authority.
-- No email, role claim, or application-supplied tenant identifier grants access.
create or replace function hub.authorize_platform_admin()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_session_text text := (select auth.jwt() ->> 'session_id');
begin
  if v_user_id is null or not private.current_user_is_usable()
    or v_session_text is null
    or v_session_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Current administrator session required.' using errcode = '28000';
  end if;

  if not private.current_session_is_aal2() or not exists (
    select 1 from auth.sessions session
    join auth.mfa_factors factor
      on factor.id = session.factor_id and factor.user_id = session.user_id
    where session.id = v_session_text::uuid and session.user_id = v_user_id
      and session.aal = 'aal2' and session.oauth_client_id is null
      and (session.not_after is null or session.not_after > now())
      and factor.factor_type = 'totp' and factor.status = 'verified'
  ) then
    raise exception 'Current administrator session required.' using errcode = '28000';
  end if;

  if not exists (select 1 from hub.profiles where id = v_user_id)
    or not exists (
      select 1 from private.staff_permissions permission
      where permission.user_id = v_user_id and permission.permission = 'platform.admin'
        and permission.product_id is null and permission.revoked_at is null
    ) then
    raise exception 'Portfolio administrator permission required.' using errcode = '42501';
  end if;

  return jsonb_build_object('user_id', v_user_id, 'role', 'platform_admin', 'aal', 'aal2');
end;
$$;

revoke all on function hub.authorize_platform_admin() from public, anon;
grant execute on function hub.authorize_platform_admin() to authenticated;

-- The frontend now requires both the central learning runtime and delegated auth.
do $$
begin
  if to_regprocedure('hub.get_learning_editor_access()') is null
    or to_regprocedure('hub.list_learning_catalog()') is null
    or to_regprocedure('hub.authorize_platform_admin()') is null then
    raise exception 'Apply central learning and administrator authorization first';
  end if;
end;
$$;

create or replace function hub.get_backend_contract()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select jsonb_build_object('api_version', 2); $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;


-- 20260911152329_governed_learning_snapshots.sql
-- Source preservation only. No source or Hub course, publication, enrollment,
-- assignment, completion, credit, certificate, or media writer is changed here.
create extension if not exists pg_jsonschema with schema extensions;

-- Generated from governedCourseSchema. The contract test compares this schema to
-- the TypeScript definition so bypassing browser validation cannot relax it.
create function private.governed_learning_schema() returns json
language sql immutable set search_path='' as $$
select $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"contract":{"type":"string","const":"carebase.course.v1"},"sourceCourseId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sourceVersionId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sourceVersionNumber":{"type":"integer","minimum":-2147483648,"maximum":2147483647},"publicationState":{"type":"string","enum":["draft","published","archived"]},"sourceVersionState":{"type":"string","enum":["draft","published"]},"course":{"type":"object","properties":{"title":{"type":"string","maxLength":250000},"description":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"category":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"estimatedDurationMinutes":{"anyOf":[{"type":"integer","minimum":0,"maximum":2147483647},{"type":"null"}]},"catalogCode":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"recurrenceIntervalDays":{"anyOf":[{"type":"integer","minimum":1,"maximum":2147483647},{"type":"null"}]},"legacyTrainingTypeId":{"anyOf":[{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},{"type":"null"}]},"renewalTrainingTypeId":{"anyOf":[{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},{"type":"null"}]},"creditedDurationCheckExempt":{"type":"boolean"}},"required":["title","description","category","estimatedDurationMinutes","catalogCode","recurrenceIntervalDays","legacyTrainingTypeId","renewalTrainingTypeId","creditedDurationCheckExempt"],"additionalProperties":false},"version":{"type":"object","properties":{"title":{"type":"string","maxLength":250000},"description":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"label":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"contentStandard":{"type":"string","enum":["legacy","comprehensive"]},"creditedDurationRationale":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"aiGenerated":{"type":"boolean"},"aiReviewedAt":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]}},"required":["title","description","label","contentStandard","creditedDurationRationale","aiGenerated","aiReviewedAt"],"additionalProperties":false},"blocks":{"maxItems":500,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"type":{"type":"string","enum":["text","video","pdf","scorm","quiz","attestation"]},"sortOrder":{"type":"integer","minimum":-2147483648,"maximum":2147483647},"title":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"body":{"$ref":"#/definitions/__schema0"},"documentId":{"anyOf":[{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},{"type":"null"}]},"videoLocatorSha256":{"anyOf":[{"type":"string","pattern":"^[0-9a-f]{64}$"},{"type":"null"}]},"quiz":{"anyOf":[{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"title":{"type":"string","maxLength":250000},"passingScore":{"type":"integer","minimum":0,"maximum":100},"maxAttempts":{"anyOf":[{"type":"integer","minimum":1,"maximum":2147483647},{"type":"null"}]},"kind":{"type":"string","enum":["assessment","knowledge_check","final_exam"]},"shuffleQuestions":{"type":"boolean"},"shuffleAnswers":{"type":"boolean"},"revealsAnswersAfterAttempt":{"type":"boolean"},"questions":{"maxItems":500,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sortOrder":{"type":"integer","minimum":-2147483648,"maximum":2147483647},"prompt":{"type":"string","maxLength":250000},"type":{"type":"string","enum":["single_choice","multiple_choice","true_false"]},"points":{"type":"integer","minimum":1,"maximum":2147483647},"topicCode":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"topicLabel":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"explanation":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"options":{"maxItems":100,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sortOrder":{"type":"integer","minimum":-2147483648,"maximum":2147483647},"text":{"type":"string","maxLength":250000},"correct":{"type":"boolean"}},"required":["id","sortOrder","text","correct"],"additionalProperties":false}}},"required":["id","sortOrder","prompt","type","points","topicCode","topicLabel","explanation","options"],"additionalProperties":false}}},"required":["id","title","passingScore","maxAttempts","kind","shuffleQuestions","shuffleAnswers","revealsAnswersAfterAttempt","questions"],"additionalProperties":false},{"type":"null"}]}},"required":["id","type","sortOrder","title","body","documentId","videoLocatorSha256","quiz"],"additionalProperties":false}},"credits":{"maxItems":100,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"trainingTypeId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"topicCode":{"type":"string","maxLength":250000},"creditHours":{"type":"string","pattern":"^\\d{1,4}(\\.\\d{1,2})?$"},"mode":{"type":"string","enum":["automatic","verified_only"]},"citationNote":{"type":"string","maxLength":250000},"active":{"type":"boolean"}},"required":["id","trainingTypeId","topicCode","creditHours","mode","citationNote","active"],"additionalProperties":false}},"provider":{"anyOf":[{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"fullName":{"type":"string","maxLength":250000},"professionalTitle":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"credential":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"credentialNumber":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"credentialIssuingOrganization":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"credentialExpiresOn":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"courseAuthor":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"signatureName":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"signatureRecordedAt":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"contentVersion":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"lastClinicalReviewDate":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"reviewedBy":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"nextReviewDue":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"regulationReviewDate":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"reviewNotes":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]}},"required":["id","fullName","professionalTitle","credential","credentialNumber","credentialIssuingOrganization","credentialExpiresOn","courseAuthor","signatureName","signatureRecordedAt","contentVersion","lastClinicalReviewDate","reviewedBy","nextReviewDue","regulationReviewDate","reviewNotes"],"additionalProperties":false},{"type":"null"}]},"packages":{"maxItems":100,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"standard":{"type":"string","enum":["scorm_1_2","scorm_2004_4th","xapi","lti_1_3"]},"contentSha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"entryPoint":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"manifest":{"$ref":"#/definitions/__schema1"},"capabilities":{"maxItems":100,"type":"array","items":{"type":"string","maxLength":250000}},"connectivityMode":{"type":"string","enum":["online_only","offline_supported"]},"validationStatus":{"type":"string","enum":["pending","validating","accepted","rejected","quarantined"]}},"required":["id","standard","contentSha256","entryPoint","manifest","capabilities","connectivityMode","validationStatus"],"additionalProperties":false}}},"required":["contract","sourceCourseId","sourceVersionId","sourceVersionNumber","publicationState","sourceVersionState","course","version","blocks","credits","provider","packages"],"additionalProperties":false,"definitions":{"__schema0":{"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"},{"type":"array","items":{"$ref":"#/definitions/__schema0"}},{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"$ref":"#/definitions/__schema0"}}]},"__schema1":{"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"},{"type":"array","items":{"$ref":"#/definitions/__schema1"}},{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"$ref":"#/definitions/__schema1"}}]}}}$schema$::json;
$$;

create function private.validate_governed_learning_source(p_payload text, p_revision text) returns jsonb
language plpgsql set search_path='' as $$
declare document jsonb;
begin
  if p_payload is null or octet_length(p_payload)>2000000 or p_revision is null
    or p_revision !~ '^[0-9a-f]{64}$'
    or encode(extensions.digest(p_payload,'sha256'),'hex')<>p_revision then
    raise exception 'Source revision checksum or size is invalid.' using errcode='22023';
  end if;
  begin document:=p_payload::jsonb;
  exception when invalid_text_representation then
    raise exception 'Source payload is not valid JSON.' using errcode='22023';
  end;
  if not extensions.jsonb_matches_schema(private.governed_learning_schema(),document) then
    raise exception 'Source snapshot does not match carebase.course.v1.' using errcode='22023';
  end if;
  if document::text ~* '([?&](token|access_token|signature|sig|key|policy|jwt|auth|h|hdnts|hdnea|key-pair-id|api_key|apikey|x-amz-[a-z-]+|x-goog-[a-z-]+)=|"(access_token|refresh_token|service_role_key|authorization|accessToken|refreshToken|password|client_secret|storage_path|storage_bucket|video_url|playback_url|signed_url)"[[:space:]]*:)' then
    raise exception 'Remove playback credentials from the source export before staging.' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(document->'blocks') b
    where ((b->>'type'='quiz') is distinct from (b->'quiz'<>'null'::jsonb))
      or ((b->'quiz'->>'revealsAnswersAfterAttempt')::boolean and b->'quiz'->>'kind'<>'knowledge_check')) then
    raise exception 'Source quiz configuration is invalid.' using errcode='22023';
  end if;
  if exists(
    with blocks as(select value b from jsonb_array_elements(document->'blocks')),
    questions as(select q from blocks cross join lateral jsonb_array_elements(coalesce(nullif(b->'quiz'->'questions','null'::jsonb),'[]'::jsonb)) q),
    ids as (
      select 'block' kind, lower(b->>'id') id from blocks
      union all select 'quiz',lower(b->'quiz'->>'id') from blocks where b->'quiz'<>'null'::jsonb
      union all select 'question',lower(q->>'id') from questions
      union all select 'answer',lower(a->>'id') from questions cross join lateral jsonb_array_elements(q->'options') a
      union all select 'credit',lower(c->>'id') from jsonb_array_elements(document->'credits') c
      union all select 'package',lower(p->>'id') from jsonb_array_elements(document->'packages') p
    ) select 1 from ids group by kind,id having count(*)>1
  ) then raise exception 'The source snapshot repeats a content identifier.' using errcode='22023'; end if;
  return document;
end;
$$;

create table private.learning_source_snapshots (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references hub.content_items(id),
  source_course_id uuid not null,
  source_version_id uuid not null,
  source_revision text not null check(source_revision ~ '^[0-9a-f]{64}$'),
  sequence integer not null check(sequence>0),
  publication_state text not null check(publication_state in ('draft','published','archived')),
  source_payload text not null check(octet_length(source_payload)<=2000000),
  staged_by uuid not null references hub.profiles(id),
  staged_at timestamptz not null default now(),
  unique(source_course_id,source_revision),
  unique(source_course_id,sequence)
);
create index learning_source_snapshots_item_idx on private.learning_source_snapshots(item_id);
create index learning_source_snapshots_actor_idx on private.learning_source_snapshots(staged_by);
alter table private.learning_source_snapshots enable row level security;
revoke all on private.learning_source_snapshots from public,anon,authenticated;

create function hub.stage_learning_source(p_payload text,p_source_revision text,p_expected_revision text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare editor uuid; doc jsonb; item uuid; source_id uuid; prior private.learning_source_snapshots%rowtype;
  head private.learning_source_snapshots%rowtype; staged private.learning_source_snapshots%rowtype;
begin
  editor:=private.require_learning_editor();
  doc:=private.validate_governed_learning_source(p_payload,p_source_revision);
  source_id:=(doc->>'sourceCourseId')::uuid;
  -- The existing catalog item is the lock boundary for all imports of a source
  -- course. Concurrent first imports serialize without a second mutable head.
  select l.content_item_id into item from hub.course_links l join hub.content_items i on i.id=l.content_item_id
    where lower(l.penntrain_course_id)=source_id::text and i.kind='course' and i.source_system='penntrain'
    for update of i;
  if not found then raise exception 'Source course is not registered in the central catalog.' using errcode='22023'; end if;
  select * into head from private.learning_source_snapshots where source_course_id=source_id order by sequence desc limit 1;
  select * into prior from private.learning_source_snapshots where source_course_id=source_id and source_revision=p_source_revision;
  if found then
    -- Replaying a historical revision acknowledges it but NEVER rewinds the head.
    return jsonb_build_object('snapshotId',prior.id,'sourceRevision',prior.source_revision,
      'headRevision',head.source_revision,'sequence',prior.sequence,'replayed',true);
  end if;
  if p_expected_revision is distinct from head.source_revision then
    raise exception 'A newer source snapshot was staged. Reload the export preview before continuing.' using errcode='40001';
  end if;
  insert into private.learning_source_snapshots(item_id,source_course_id,source_version_id,source_revision,sequence,publication_state,source_payload,staged_by)
    values(item,source_id,(doc->>'sourceVersionId')::uuid,p_source_revision,coalesce(head.sequence,0)+1,doc->>'publicationState',p_payload,editor)
    returning * into staged;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(editor,'learning.source.staged','content_item',item,jsonb_build_object('source_revision',p_source_revision,'sequence',staged.sequence));
  return jsonb_build_object('snapshotId',staged.id,'sourceRevision',staged.source_revision,
    'headRevision',staged.source_revision,'sequence',staged.sequence,'replayed',false);
end;
$$;

create function hub.list_learning_source_heads() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.require_learning_editor();
  return coalesce((select jsonb_agg(jsonb_build_object('sourceCourseId',s.source_course_id,'snapshotId',s.id,
    'sourceRevision',s.source_revision,'sequence',s.sequence,'publicationState',s.publication_state) order by s.source_course_id)
    from (select distinct on(source_course_id) * from private.learning_source_snapshots order by source_course_id,sequence desc) s),'[]'::jsonb);
end;
$$;

create function hub.get_learning_source_snapshot(p_snapshot_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.require_learning_editor();
  select jsonb_build_object('sourceRevision',source_revision,'payload',source_payload) into result
    from private.learning_source_snapshots where id=p_snapshot_id;
  if result is null then raise exception 'Source snapshot unavailable.' using errcode='22023'; end if;
  return result;
end;
$$;
revoke all on function private.governed_learning_schema(),private.validate_governed_learning_source(text,text) from public,anon,authenticated;
revoke all on function hub.stage_learning_source(text,text,text),hub.list_learning_source_heads(),hub.get_learning_source_snapshot(uuid) from public,anon,authenticated;
grant execute on function hub.stage_learning_source(text,text,text),hub.list_learning_source_heads(),hub.get_learning_source_snapshot(uuid) to authenticated;


-- 20260911154818_governed_learning_backend_contract.sql
-- Release 3 may expose governed import UI only after its full staging API exists.
do $$
begin
  if to_regprocedure('hub.get_learning_editor_access()') is null
    or to_regprocedure('hub.authorize_platform_admin()') is null
    or to_regprocedure('hub.stage_learning_source(text,text,text)') is null
    or to_regprocedure('hub.list_learning_source_heads()') is null
    or to_regprocedure('hub.get_learning_source_snapshot(uuid)') is null
    or to_regprocedure('extensions.jsonb_matches_schema(json,jsonb)') is null
    or to_regclass('private.learning_source_snapshots') is null then
    raise exception 'Apply governed learning preservation and administrator authorization first';
  end if;
end;
$$;
create or replace function hub.get_backend_contract()
returns jsonb language sql stable security invoker set search_path=''
as $$ select jsonb_build_object('api_version',3); $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- Delegated command authorization and release contract 4.
-- Mutation delegation retains the native CareBase eight-hour privileged-session
-- window. Refreshing a token does not extend the original session creation time.
create function hub.authorize_platform_command()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  actor jsonb;
  session_id uuid;
  started_at timestamptz;
  not_after timestamptz;
  issued_at text := (select auth.jwt()->>'iat');
begin
  actor := hub.authorize_platform_admin();
  session_id := (select auth.jwt()->>'session_id')::uuid;
  select s.created_at,s.not_after into started_at,not_after
    from auth.sessions s where s.id=session_id and s.user_id=(actor->>'user_id')::uuid;
  if started_at is null or started_at < now()-interval '480 minutes'
    or started_at > now()+interval '5 minutes'
    or issued_at is null or issued_at !~ '^[0-9]{1,12}$' then
    raise exception 'Sign in again before changing application access.' using errcode='28000';
  end if;
  if issued_at::numeric > extract(epoch from now()+interval '5 minutes') then
    raise exception 'Sign in again before changing application access.' using errcode='28000';
  end if;
  return actor || jsonb_build_object('session_id',session_id,'session_started_at',started_at,
    'assurance_expires_at',least(started_at+interval '480 minutes',not_after));
end;
$$;
revoke all on function hub.authorize_platform_command() from public,anon,authenticated;
grant execute on function hub.authorize_platform_command() to authenticated;

do $$ begin
  if to_regprocedure('hub.authorize_platform_command()') is null
    or to_regprocedure('hub.stage_learning_source(text,text,text)') is null
    or (hub.get_backend_contract()->>'api_version')::integer < 3 then
    raise exception 'Apply governed learning and command authorization before contract 4';
  end if;
end $$;
create or replace function hub.get_backend_contract()
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('api_version',4);
$$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- First-party SMS sessions. Telnyx verifies the code; the Hub owns the session.
-- Supabase Auth rows remain identity references, not the SMS verification service.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='hub_app_server') then
    create role hub_app_server nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;
grant authenticated, anon to hub_app_server;
grant usage on schema private, hub to hub_app_server;

create table private.sms_identities (
  user_id uuid primary key references auth.users(id),
  phone_e164 text not null unique check(phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  identity_version uuid not null default gen_random_uuid(),
  verified_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table private.sms_challenges (
  id uuid primary key,
  user_id uuid references private.sms_identities(user_id),
  identity_version uuid,
  phone_hash text not null,
  client_hash text not null,
  browser_hash text not null,
  provider_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '5 minutes',
  attempts integer not null default 0 check(attempts between 0 and 5),
  consumed_at timestamptz
);
create index sms_challenge_phone_time on private.sms_challenges(phone_hash,created_at);
create index sms_challenge_client_time on private.sms_challenges(client_hash,created_at);
create index sms_challenge_user on private.sms_challenges(user_id);
create table private.sms_sessions (
  id uuid primary key,
  token_hash text not null unique,
  user_id uuid not null references private.sms_identities(user_id),
  identity_version uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sms_sessions_user on private.sms_sessions(user_id);
create table private.app_delegations (
  token_hash text primary key,
  session_id uuid not null references private.sms_sessions(id),
  audience text not null check(audience in ('carebase','media')),
  payload jsonb not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index app_delegations_session on private.app_delegations(session_id);

-- Changing or disabling a registered number invalidates every old challenge and session.
create function private.rotate_sms_identity() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.phone_e164 is distinct from old.phone_e164 or new.revoked_at is distinct from old.revoked_at then
    new.identity_version:=gen_random_uuid(); new.verified_at:=null;
  end if;
  return new;
end;
$$;
revoke all on function private.rotate_sms_identity() from public,anon,authenticated;
create trigger rotate_sms_identity before update on private.sms_identities
for each row execute function private.rotate_sms_identity();

alter table private.sms_identities enable row level security;
alter table private.sms_challenges enable row level security;
alter table private.sms_sessions enable row level security;
alter table private.app_delegations enable row level security;
revoke all on private.sms_identities,private.sms_challenges,private.sms_sessions,private.app_delegations from public,anon,authenticated;
grant select on private.sms_identities to hub_app_server;
grant update(verified_at) on private.sms_identities to hub_app_server;
grant select,insert,update,delete on private.sms_challenges,private.sms_sessions,private.app_delegations to hub_app_server;
create policy sms_identity_server on private.sms_identities for select to hub_app_server using(true);
create policy sms_identity_verify on private.sms_identities for update to hub_app_server using(true) with check(true);
create policy sms_challenge_server on private.sms_challenges for all to hub_app_server using(true) with check(true);
create policy sms_session_server on private.sms_sessions for all to hub_app_server using(true) with check(true);
create policy app_delegation_server on private.app_delegations for all to hub_app_server using(true) with check(true);

create function private.current_app_session_verified() returns boolean
language sql stable security definer set search_path='' as $$
  select session_user='hub_app_server' and private.current_user_is_usable() and exists (
    select 1 from private.sms_sessions s join private.sms_identities i on i.user_id=s.user_id
    where s.id::text=(select auth.jwt()->>'sms_session_id') and s.user_id=(select auth.uid())
      and s.identity_version=i.identity_version and i.revoked_at is null
      and s.revoked_at is null and s.expires_at>now()
  );
$$;
create function private.current_session_is_verified() returns boolean
language sql stable security definer set search_path='' as $$
  select private.current_app_session_verified() or private.current_session_is_aal2();
$$;
revoke all on function private.current_app_session_verified(),private.current_session_is_verified() from public,anon,authenticated;

-- Preserve existing role/tenant checks while accepting the app-owned verified
-- session at every protected RPC. Legacy AAL2 checks keep their original meaning.
do $$ declare fn record; definition text;
begin
  for fn in
    select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('private','hub') and p.prokind='f'
      and p.proname not in ('current_session_is_aal2','current_session_is_verified','authorize_platform_admin')
      and p.prosrc like '%private.current_session_is_aal2()%'
  loop
    definition := replace(pg_get_functiondef(fn.oid),'private.current_session_is_aal2()','private.current_session_is_verified()');
    execute definition;
  end loop;
end $$;

create function hub.authorize_app_admin() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not private.current_app_session_verified() or not private.has_staff_permission('platform.admin',null) then
    raise exception 'Current administrator session required.' using errcode='28000';
  end if;
  return jsonb_build_object('user_id',auth.uid(),'role','platform_admin','method','sms');
end;
$$;
revoke all on function hub.authorize_app_admin() from public,anon;
grant execute on function hub.authorize_app_admin() to authenticated;

create function hub.authorize_learning_object(p_path text,p_operation text) returns boolean
language sql stable security definer set search_path='' as $$
  select private.current_app_session_verified()
    and p_path ~ '^learning/[0-9a-f-]{36}/(video.mp4|captions.vtt|transcript.txt)$'
    and case when p_operation='upload' then private.can_upload_learning_object(p_path)
      when p_operation in ('download','sign') then private.can_read_learning_object(p_path) else false end;
$$;
revoke all on function hub.authorize_learning_object(text,text) from public,anon;
grant execute on function hub.authorize_learning_object(text,text) to authenticated;

create function private.usable_sms_identity(p_phone text) returns table(user_id uuid,identity_version uuid)
language sql stable security definer set search_path='' as $$
  select i.user_id,i.identity_version from private.sms_identities i
    join auth.users u on u.id=i.user_id join hub.profiles p on p.id=u.id
    where i.phone_e164=p_phone and i.revoked_at is null and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=now()) and not coalesce(u.is_anonymous,false);
$$;
revoke all on function private.usable_sms_identity(text) from public,anon,authenticated;
grant execute on function private.usable_sms_identity(text) to hub_app_server;

create or replace function hub.get_backend_contract() returns jsonb
language sql stable security invoker set search_path='' as $$ select jsonb_build_object('api_version',3); $$;

-- No login password, telephone number, provider key, or session is provisioned
-- in source. The deployment operator binds an approved number to an existing
-- user and enables the dedicated server role with a generated secret.

-- Intake still needs an active, verified support owner.
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
          and (exists (
            select 1 from auth.mfa_factors factor
            where factor.user_id = permission.user_id
              and factor.factor_type = 'totp'
              and factor.status = 'verified'
          ) or exists (
            select 1 from private.sms_identities sms
            where sms.user_id=permission.user_id and sms.revoked_at is null and sms.verified_at is not null
          ))
      )
  );
$$;

-- Each native administrator adapter receives a different single-use audience.
alter table private.app_delegations drop constraint app_delegations_audience_check;
alter table private.app_delegations add constraint app_delegations_audience_check
  check(audience in ('carebase','breathe','media'));

-- Preserve the already deployed SMS migration and combine independently shipped
-- features. API version 4 remains stable for additive, explicitly named features.
create function hub.authorize_app_command() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor jsonb; session private.sms_sessions%rowtype; expires timestamptz;
begin
  actor:=hub.authorize_app_admin();
  select * into session from private.sms_sessions
    where id::text=(select auth.jwt()->>'sms_session_id') and user_id=(select auth.uid());
  if not found or session.created_at<now()-interval '8 hours'
    or session.created_at>now()+interval '5 minutes' then
    raise exception 'Current administrator session required.' using errcode='28000';
  end if;
  expires:=least(session.expires_at,session.created_at+interval '8 hours');
  if expires<=now() then
    raise exception 'Current administrator session required.' using errcode='28000';
  end if;
  return actor || jsonb_build_object('session_id',session.id,
    'session_started_at',session.created_at,'assurance_expires_at',expires);
end;
$$;
revoke all on function hub.authorize_app_command() from public,anon;
grant execute on function hub.authorize_app_command() to authenticated;

alter table private.app_delegations drop constraint app_delegations_audience_check;
alter table private.app_delegations add constraint app_delegations_audience_check
  check(audience in ('carebase','breathe','caremetric-emr','pennsync','carebase.command','media'));

do $$
begin
  if to_regprocedure('hub.authorize_platform_admin()') is null
    or to_regprocedure('hub.authorize_platform_command()') is null
    or to_regprocedure('hub.authorize_app_admin()') is null
    or to_regprocedure('hub.authorize_app_command()') is null
    or to_regprocedure('private.current_app_session_verified()') is null
    or to_regprocedure('hub.stage_learning_source(text,text,text)') is null
    or to_regprocedure('hub.list_learning_source_heads()') is null
    or to_regprocedure('hub.get_learning_source_snapshot(uuid)') is null
    or to_regprocedure('hub.get_learning_editor_access()') is null
    or to_regprocedure('extensions.jsonb_matches_schema(json,jsonb)') is null
    or to_regclass('private.learning_source_snapshots') is null
    or to_regclass('private.sms_sessions') is null then
    raise exception 'Apply all reviewed learning, SMS and administrator migrations first';
  end if;
end;
$$;
create or replace function hub.get_backend_contract() returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('api_version',4,'features',jsonb_build_array(
    'learning.runtime.v1','platform.admin.read.v1','app.sms.v1',
    'learning.sources.v1','platform.admin.command.v1'));
$$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- Prospective learning receipts and explicit canonical access (2026-09-11)
-- The inbox is a reporting projection of native completion evidence. It never
-- enrolls learners, issues certificates, grants credits, or rewrites history.
create function private.learning_receipt_schema() returns json
language sql immutable set search_path='' as $$ select $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"contract":{"type":"string","const":"caremetric.learning-receipt.v1"},"source":{"type":"string","const":"carebase"},"eventId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"kind":{"type":"string","enum":["completed","retracted"]},"sequence":{"type":"integer","minimum":1,"maximum":2147483647},"mappingId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"assignmentId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sourceCourseId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sourceVersionId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"mappingRevision":{"type":"string","pattern":"^[0-9a-f]{64}$"},"assignmentRevision":{"type":"string","pattern":"^[0-9a-f]{64}$"},"completionRevision":{"type":"string","pattern":"^[0-9a-f]{64}$"},"hubTenantId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"hubUserId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"completedAt":{"type":"string","maxLength":40,"pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$"},"evidenceSha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"finalExamScore":{"anyOf":[{"type":"number","minimum":0,"maximum":100},{"type":"null"}]},"certificate":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"issuedAt":{"type":"string","maxLength":40,"pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$"},"expiresAt":{"anyOf":[{"type":"string","maxLength":40,"pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$"},{"type":"null"}]},"providerEvidenceSha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["id","issuedAt","expiresAt","providerEvidenceSha256"],"additionalProperties":false},"credits":{"maxItems":100,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"trainingTypeId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"topicCode":{"type":"string","maxLength":200},"hours":{"type":"string","pattern":"^\\d{1,4}(\\.\\d{1,2})?$"},"year":{"type":"integer","minimum":2000,"maximum":2200},"creditedAt":{"type":"string","maxLength":40,"pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$"}},"required":["id","trainingTypeId","topicCode","hours","year","creditedAt"],"additionalProperties":false}},"attestations":{"maxItems":500,"type":"array","items":{"type":"object","properties":{"blockId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"version":{"type":"string","maxLength":500},"statementSha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"attestedAt":{"type":"string","maxLength":40,"pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$"}},"required":["blockId","version","statementSha256","attestedAt"],"additionalProperties":false}},"quizEvidenceSha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"renewalEvidenceSha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["contract","source","eventId","kind","sequence","mappingId","assignmentId","sourceCourseId","sourceVersionId","mappingRevision","assignmentRevision","completionRevision","hubTenantId","hubUserId","completedAt","evidenceSha256","finalExamScore","certificate","credits","attestations","quizEvidenceSha256","renewalEvidenceSha256"],"additionalProperties":false}$schema$::json; $$;

create function private.require_receipt_command_actor(p_actor_id uuid,p_session_id uuid) returns void
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from auth.users u join hub.profiles p on p.id=u.id
    join auth.sessions s on s.user_id=u.id join auth.mfa_factors f on f.id=s.factor_id and f.user_id=s.user_id
    where u.id=p_actor_id and u.deleted_at is null and not coalesce(u.is_anonymous,false)
      and (u.banned_until is null or u.banned_until<=now()) and s.id=p_session_id and s.aal='aal2'
      and s.oauth_client_id is null and (s.not_after is null or s.not_after>now())
      and s.created_at>now()-interval '480 minutes' and s.created_at<=now()
      and f.factor_type='totp' and f.status='verified'
      and exists(select 1 from private.staff_permissions sp where sp.user_id=u.id and sp.permission='platform.admin'
        and sp.product_id is null and sp.revoked_at is null)) then
    raise exception 'Current administrator command session required.' using errcode='42501';
  end if;
end;
$$;

create table private.learning_receipt_mappings (
  id uuid primary key,
  source_snapshot_id uuid not null references private.learning_source_snapshots(id),
  native_organization_id uuid not null,
  native_employee_id uuid not null,
  hub_tenant_id uuid not null,
  hub_user_id uuid not null,
  product_id uuid not null references hub.products(id),
  state text not null check(state in ('pending','active','revoked')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  revoked_at timestamptz
);
create table private.learning_receipt_inbox (
  event_id uuid primary key,
  mapping_id uuid not null references private.learning_receipt_mappings(id),
  assignment_id uuid not null,
  sequence integer not null check(sequence>0),
  kind text not null check(kind in ('completed','retracted')),
  source_digest text not null check(source_digest ~ '^[0-9a-f]{64}$'),
  payload text not null check(octet_length(payload)<=100000),
  accepted_by uuid not null,
  accepted_at timestamptz not null default now(),
  unique(assignment_id,sequence)
);
create index learning_receipt_mappings_source on private.learning_receipt_mappings(source_snapshot_id);
create index learning_receipt_mappings_tenant on private.learning_receipt_mappings(hub_tenant_id);
create index learning_receipt_mappings_user on private.learning_receipt_mappings(hub_user_id);
create index learning_receipt_mappings_product on private.learning_receipt_mappings(product_id);
create index learning_receipt_mappings_actor on private.learning_receipt_mappings(created_by);
create index learning_receipt_inbox_mapping on private.learning_receipt_inbox(mapping_id);
create index learning_receipt_inbox_actor on private.learning_receipt_inbox(accepted_by);
alter table private.learning_receipt_mappings enable row level security;
alter table private.learning_receipt_inbox enable row level security;
revoke all on private.learning_receipt_mappings,private.learning_receipt_inbox from public,anon,authenticated,service_role;

create function private.receipt_membership_is_active(p_tenant uuid,p_user uuid,p_product uuid) returns boolean
language sql stable security definer set search_path='' as $$
select exists(select 1 from hub.tenant_product_memberships m join hub.tenant_products tp on tp.tenant_id=m.tenant_id and tp.product_id=m.product_id
  join hub.tenants t on t.id=m.tenant_id join auth.users u on u.id=m.user_id where m.tenant_id=p_tenant and m.user_id=p_user and m.product_id=p_product
    and m.status='active' and tp.status='active' and t.status='active' and u.deleted_at is null and not coalesce(u.is_anonymous,false)
    and (u.banned_until is null or u.banned_until<=now()));
$$;

-- Version 1: lowerhex SHA256 of canonical lowercase UUID UTF8, issuer-scoped.
create function private.carebase_external_identity_hash(p_id uuid) returns text
language sql immutable strict set search_path='' as $$ select encode(extensions.digest(p_id::text,'sha256'),'hex'); $$;

-- Learning-specific employee/profile relationship; canonical user and tenant
-- ownership lives exclusively in the existing federation tables.
create table private.learning_employee_bindings (
  native_employee_id uuid primary key, native_profile_id uuid not null unique, native_organization_id uuid not null,
  issuer_id uuid not null, external_subject_hash text not null, external_tenant_hash text not null,
  created_by uuid not null, created_at timestamptz not null default now(),
  foreign key(issuer_id,external_subject_hash) references private.federated_principals(issuer_id,external_subject_hash) on delete cascade,
  foreign key(issuer_id,external_tenant_hash) references private.federated_tenants(issuer_id,external_tenant_hash) on delete cascade
);
create index learning_employee_principal on private.learning_employee_bindings(issuer_id,external_subject_hash);
create index learning_employee_tenant on private.learning_employee_bindings(issuer_id,external_tenant_hash);
alter table private.learning_employee_bindings enable row level security;
revoke all on private.learning_employee_bindings from public,anon,authenticated,service_role;
create function private.learning_receipt_identity_active(p_organization uuid,p_employee uuid,p_tenant uuid,p_user uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.learning_employee_bindings e
    join private.federated_principals p on p.issuer_id=e.issuer_id and p.external_subject_hash=e.external_subject_hash
    join private.federated_tenants t on t.issuer_id=e.issuer_id and t.external_tenant_hash=e.external_tenant_hash
    where e.native_organization_id=p_organization and e.native_employee_id=p_employee and p.revoked_at is null
      and p.hub_user_id=p_user and t.hub_tenant_id=p_tenant
      and e.external_subject_hash=private.carebase_external_identity_hash(e.native_profile_id)
      and e.external_tenant_hash=private.carebase_external_identity_hash(e.native_organization_id));
$$;

-- The coordinator verifies native IDs before each call. Explicit choice of an
-- EXISTING Hub account; no names/email matching, no invitation, no auto-merge.
create function hub.provision_learning_receipt_access(p_actor_id uuid,p_session_id uuid,p_native_organization_id uuid,
  p_native_employee_id uuid,p_native_profile_id uuid,p_hub_tenant_id uuid,p_tenant_name text,p_hub_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare product uuid; prior_tenant uuid; v_issuer_id uuid; subject_hash text; tenant_hash text;
  principal private.federated_principals%rowtype; employee private.learning_employee_bindings%rowtype;
begin
  perform private.require_receipt_command_actor(p_actor_id,p_session_id);
  if p_native_organization_id is null or p_native_employee_id is null or p_native_profile_id is null or p_hub_tenant_id is null
    or p_tenant_name is null or char_length(btrim(p_tenant_name)) not between 2 and 180 then
    raise exception 'Explicit verified native identifiers and canonical tenant required.' using errcode='22023'; end if;
  select id into product from hub.products where slug='carebase' and status<>'retired';
  if product is null or not exists(select 1 from auth.users u join hub.profiles p on p.id=u.id where u.id=p_hub_user_id
    and u.deleted_at is null and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=now())) then
    raise exception 'Existing active Hub account and product required.' using errcode='22023'; end if;
  -- Verified public OIDC discovery and JWKS, 2026-09-11. Metadata does not enable
  -- JWT federation. Authenticated learning pull uses its own reviewed authority.
  insert into private.federation_issuers(product_id,issuer,audience,jwks_url,enabled)
    values(product,'https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1','authenticated',
      'https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1/.well-known/jwks.json',false) on conflict(issuer) do nothing;
  select id into v_issuer_id from private.federation_issuers f where f.issuer='https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1'
    and f.product_id=product and f.audience='authenticated' and f.jwks_url='https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1/.well-known/jwks.json';
  if v_issuer_id is null then raise exception 'Review the existing CareBase issuer configuration.' using errcode='40001'; end if;
  subject_hash:=private.carebase_external_identity_hash(p_native_profile_id);
  tenant_hash:=private.carebase_external_identity_hash(p_native_organization_id);
  perform pg_advisory_xact_lock(hashtextextended('carebase-tenant:'||p_native_organization_id::text,0));
  select hub_tenant_id into prior_tenant from private.federated_tenants t where t.issuer_id=v_issuer_id and t.external_tenant_hash=tenant_hash;
  if prior_tenant is null then
    insert into hub.tenants(id,slug,name) values(p_hub_tenant_id,'carebase-'||p_native_organization_id::text,btrim(p_tenant_name));
    insert into private.federated_tenants(issuer_id,external_tenant_hash,hub_tenant_id) values(v_issuer_id,tenant_hash,p_hub_tenant_id);
    insert into hub.tenant_products(tenant_id,product_id) values(p_hub_tenant_id,product);
    insert into private.case_intake_settings(tenant_id,product_id,enabled) values(p_hub_tenant_id,product,false) on conflict do nothing;
  else
    -- Reuse the already reviewed exact native-ID mapping; never repoint it.
    p_hub_tenant_id:=prior_tenant;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('carebase-principal:'||p_native_profile_id::text,0));
  select * into principal from private.federated_principals p where p.issuer_id=v_issuer_id and p.external_subject_hash=subject_hash for update;
  if found then
    if principal.hub_user_id<>p_hub_user_id then raise exception 'Native principal cannot be repointed.' using errcode='40001'; end if;
    if principal.revoked_at is not null then raise exception 'Existing revoked or suspended access requires separate review.' using errcode='42501'; end if;
  else
    insert into private.federated_principals(issuer_id,external_subject_hash,hub_user_id) values(v_issuer_id,subject_hash,p_hub_user_id);
  end if;
  select * into employee from private.learning_employee_bindings where native_employee_id=p_native_employee_id for update;
  if found then
    if employee.native_profile_id<>p_native_profile_id or employee.native_organization_id<>p_native_organization_id or employee.issuer_id<>v_issuer_id then
      raise exception 'Native employee binding cannot be repointed.' using errcode='40001'; end if;
  else
    insert into private.learning_employee_bindings(native_employee_id,native_profile_id,native_organization_id,issuer_id,external_subject_hash,external_tenant_hash,created_by)
      values(p_native_employee_id,p_native_profile_id,p_native_organization_id,v_issuer_id,subject_hash,tenant_hash,p_actor_id);
  end if;
  insert into hub.tenant_product_memberships(tenant_id,product_id,user_id,role,case_scope,can_manage_members)
    values(p_hub_tenant_id,product,p_hub_user_id,'customer','own',false) on conflict do nothing;
  if not private.receipt_membership_is_active(p_hub_tenant_id,p_hub_user_id,product) then
    raise exception 'Existing revoked or suspended access requires separate review.' using errcode='42501'; end if;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(p_actor_id,'learning.receipt_access.provision','tenant',p_hub_tenant_id,jsonb_build_object('source','carebase'));
  return jsonb_build_object('hubTenantId',p_hub_tenant_id,'hubUserId',p_hub_user_id,'nativeOrganizationId',p_native_organization_id,
    'nativeEmployeeId',p_native_employee_id,'nativeProfileId',p_native_profile_id);
end;
$$;
revoke all on function private.carebase_external_identity_hash(uuid),private.learning_receipt_identity_active(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function hub.prepare_learning_receipt_mapping(p_actor_id uuid,p_session_id uuid,p_mapping_id uuid,p_source_snapshot_id uuid,
  p_native_organization_id uuid,p_native_employee_id uuid,p_hub_tenant_id uuid,p_hub_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare snapshot private.learning_source_snapshots%rowtype; mapping private.learning_receipt_mappings%rowtype; product uuid;
begin
  perform private.require_receipt_command_actor(p_actor_id,p_session_id);
  if p_mapping_id is null or p_native_organization_id is null or p_native_employee_id is null then
    raise exception 'Explicit source mapping identifiers required.' using errcode='22023'; end if;
  if not private.learning_receipt_identity_active(p_native_organization_id,p_native_employee_id,p_hub_tenant_id,p_hub_user_id) then
    raise exception 'Provision and review native tenant and principal access first.' using errcode='42501'; end if;
  select * into snapshot from private.learning_source_snapshots where id=p_source_snapshot_id;
  select id into product from hub.products where slug='carebase' and status<>'retired';
  if snapshot.id is null or snapshot.publication_state<>'published' or product is null
    or not private.receipt_membership_is_active(p_hub_tenant_id,p_hub_user_id,product) then
    raise exception 'Reviewed published source and active Hub learner membership required.' using errcode='42501';
  end if;
  select * into mapping from private.learning_receipt_mappings where id=p_mapping_id for update;
  if found then
    if mapping.state='revoked' or mapping.source_snapshot_id<>p_source_snapshot_id or mapping.native_organization_id<>p_native_organization_id
      or mapping.native_employee_id<>p_native_employee_id or mapping.hub_tenant_id<>p_hub_tenant_id or mapping.hub_user_id<>p_hub_user_id then
      raise exception 'A receipt mapping cannot be repointed or reactivated.' using errcode='40001'; end if;
  else
    insert into private.learning_receipt_mappings(id,source_snapshot_id,native_organization_id,native_employee_id,hub_tenant_id,hub_user_id,product_id,state,created_by)
      values(p_mapping_id,p_source_snapshot_id,p_native_organization_id,p_native_employee_id,p_hub_tenant_id,p_hub_user_id,product,'pending',p_actor_id);
    insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
      values(p_actor_id,'learning.receipt.mapping.prepared','learning_mapping',p_mapping_id,jsonb_build_object('source_revision',snapshot.source_revision));
  end if;
  return jsonb_build_object('mappingId',p_mapping_id,'organizationId',p_native_organization_id,'employeeId',p_native_employee_id,
    'hubTenantId',p_hub_tenant_id,'hubUserId',p_hub_user_id,'courseId',snapshot.source_course_id,'versionId',snapshot.source_version_id,'sourceRevision',snapshot.source_revision);
end;
$$;

create function hub.set_learning_receipt_mapping_state(p_actor_id uuid,p_session_id uuid,p_mapping_id uuid,p_state text) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform private.require_receipt_command_actor(p_actor_id,p_session_id);
  if p_state not in ('active','revoked') then raise exception 'Invalid mapping state.' using errcode='22023'; end if;
  update private.learning_receipt_mappings m set state=p_state,
    activated_at=case when p_state='active' then coalesce(m.activated_at,now()) else m.activated_at end,
    revoked_at=case when p_state='revoked' then coalesce(m.revoked_at,now()) else null end
    where m.id=p_mapping_id and (p_state='revoked' or m.state<>'revoked')
      and (p_state='revoked' or (private.receipt_membership_is_active(m.hub_tenant_id,m.hub_user_id,m.product_id)
        and private.learning_receipt_identity_active(m.native_organization_id,m.native_employee_id,m.hub_tenant_id,m.hub_user_id)));
  if not found then raise exception 'Mapping unavailable or revoked.' using errcode='40001'; end if;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(p_actor_id,'learning.receipt.mapping.'||p_state,'learning_mapping',p_mapping_id,'{}'::jsonb);
end;
$$;

create function hub.ingest_learning_receipt(p_actor_id uuid,p_session_id uuid,p_payload text,p_source_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare receipt jsonb; mapping private.learning_receipt_mappings%rowtype; snapshot private.learning_source_snapshots%rowtype;
  prior private.learning_receipt_inbox%rowtype; head private.learning_receipt_inbox%rowtype; v_event_id uuid; v_assignment_id uuid;
begin
  perform private.require_receipt_command_actor(p_actor_id,p_session_id);
  if p_payload is null or octet_length(p_payload)>100000 or p_source_digest is null
    or p_source_digest !~ '^[0-9a-f]{64}$' or p_source_digest<>encode(extensions.digest(p_payload,'sha256'),'hex') then
    raise exception 'Receipt checksum or size is invalid.' using errcode='22023'; end if;
  begin receipt:=p_payload::jsonb; exception when invalid_text_representation then
    raise exception 'Receipt JSON is invalid.' using errcode='22023'; end;
  if not extensions.jsonb_matches_schema(private.learning_receipt_schema(),receipt) then
    raise exception 'Receipt does not match the source contract.' using errcode='22023'; end if;
  select * into mapping from private.learning_receipt_mappings where id=(receipt->>'mappingId')::uuid for update;
  select * into snapshot from private.learning_source_snapshots where id=mapping.source_snapshot_id;
  if mapping.id is null or snapshot.id is null
    or (receipt->>'kind'='completed' and (mapping.state<>'active'
      or not private.receipt_membership_is_active(mapping.hub_tenant_id,mapping.hub_user_id,mapping.product_id)
      or not private.learning_receipt_identity_active(mapping.native_organization_id,mapping.native_employee_id,mapping.hub_tenant_id,mapping.hub_user_id)))
    or mapping.hub_tenant_id<>(receipt->>'hubTenantId')::uuid or mapping.hub_user_id<>(receipt->>'hubUserId')::uuid
    or snapshot.source_course_id<>(receipt->>'sourceCourseId')::uuid or snapshot.source_version_id<>(receipt->>'sourceVersionId')::uuid
    or snapshot.source_revision<>receipt->>'mappingRevision' then
    raise exception 'Active explicit receipt mapping required.' using errcode='42501'; end if;
  -- No claim that a current source snapshot describes a historical/different policy.
  if snapshot.source_revision<>receipt->>'assignmentRevision' or snapshot.source_revision<>receipt->>'completionRevision' then
    raise exception 'Receipt policy drift requires separate review.' using errcode='40001'; end if;
  v_event_id:=(receipt->>'eventId')::uuid; v_assignment_id:=(receipt->>'assignmentId')::uuid;
  select * into prior from private.learning_receipt_inbox where learning_receipt_inbox.event_id=v_event_id;
  if found then
    if prior.source_digest<>p_source_digest then raise exception 'Receipt event ID was reused.' using errcode='40001'; end if;
    return jsonb_build_object('eventId',v_event_id,'accepted',true,'replayed',true);
  end if;
  -- Serialize different mapping attempts for the same native assignment as well.
  perform pg_advisory_xact_lock(hashtextextended('carebase.assignment.'||v_assignment_id::text,0));
  select * into head from private.learning_receipt_inbox where learning_receipt_inbox.assignment_id=v_assignment_id order by sequence desc limit 1;
  if head.event_id is null then
    -- A trusted withdrawal may arrive before its completion was acknowledged.
    -- Persist its tombstone; an older completion can never resurrect this head.
    if not ((receipt->>'kind'='completed' and (receipt->>'sequence')::integer=1)
      or (receipt->>'kind'='retracted' and (receipt->>'sequence')::integer=2)) then
      raise exception 'Invalid initial receipt sequence.' using errcode='40001'; end if;
  elsif head.mapping_id<>mapping.id or head.kind='retracted' or receipt->>'kind'<>'retracted'
    or (receipt->>'sequence')::integer<>head.sequence+1
    or (head.payload::jsonb - 'eventId' - 'kind' - 'sequence')<>(receipt - 'eventId' - 'kind' - 'sequence') then
    raise exception 'Receipt event is stale or changes immutable completion evidence.' using errcode='40001';
  end if;
  insert into private.learning_receipt_inbox(event_id,mapping_id,assignment_id,sequence,kind,source_digest,payload,accepted_by)
    values(v_event_id,mapping.id,v_assignment_id,(receipt->>'sequence')::integer,receipt->>'kind',p_source_digest,p_payload,p_actor_id);
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(p_actor_id,'learning.receipt.accepted','learning_receipt',v_event_id,jsonb_build_object('digest',p_source_digest,'kind',receipt->>'kind'));
  return jsonb_build_object('eventId',v_event_id,'accepted',true,'replayed',false);
end;
$$;

create function hub.get_learning_receipt_status(p_actor_id uuid,p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.require_receipt_command_actor(p_actor_id,p_session_id);
  return jsonb_build_object('mappings',coalesce((select jsonb_agg(jsonb_build_object('mappingId',m.id,'state',m.state,
    'hubTenantId',m.hub_tenant_id,'hubUserId',m.hub_user_id,'sourceSnapshotId',m.source_snapshot_id) order by m.created_at)
    from (select * from private.learning_receipt_mappings order by created_at desc limit 100) m),'[]'::jsonb),
    'receipts',coalesce((select jsonb_agg(jsonb_build_object('assignmentId',r.assignment_id,'kind',r.kind,'sequence',r.sequence,
      'eventId',r.event_id,'mappingId',r.mapping_id,'completedAt',r.payload::jsonb->>'completedAt') order by r.accepted_at desc)
      from (select * from (select distinct on(assignment_id) * from private.learning_receipt_inbox order by assignment_id,sequence desc) latest
        order by accepted_at desc limit 100) r),'[]'::jsonb),
    'tenants',coalesce((select jsonb_agg(jsonb_build_object('nativeOrganizationId',r.native_organization_id,'hubTenantId',t.hub_tenant_id,'name',h.name))
      from (select distinct native_organization_id,issuer_id,external_tenant_hash from private.learning_employee_bindings order by native_organization_id limit 100) r
      join private.federated_tenants t on t.issuer_id=r.issuer_id and t.external_tenant_hash=r.external_tenant_hash join hub.tenants h on h.id=t.hub_tenant_id),'[]'::jsonb),
    'users',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'displayName',p.display_name)) from
      (select p.* from hub.profiles p join auth.users u on u.id=p.id where u.deleted_at is null and not coalesce(u.is_anonymous,false)
        and (u.banned_until is null or u.banned_until<=now()) order by p.created_at desc limit 100) p),'[]'::jsonb),
    'snapshots',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'sourceCourseId',s.source_course_id,'sourceVersionId',s.source_version_id,
      'sourceRevision',s.source_revision,'title',s.source_payload::jsonb->'course'->>'title')) from
      (select * from (select distinct on(source_course_id) * from private.learning_source_snapshots order by source_course_id,sequence desc) latest
        where publication_state='published' limit 100) s),'[]'::jsonb),
    'mappingTotal',(select count(*) from private.learning_receipt_mappings),
    'receiptTotal',(select count(distinct assignment_id) from private.learning_receipt_inbox));
end;
$$;
revoke all on function private.learning_receipt_schema(),private.require_receipt_command_actor(uuid,uuid),private.receipt_membership_is_active(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function hub.prepare_learning_receipt_mapping(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid),hub.set_learning_receipt_mapping_state(uuid,uuid,uuid,text),
  hub.provision_learning_receipt_access(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid),
  hub.ingest_learning_receipt(uuid,uuid,text,text),hub.get_learning_receipt_status(uuid,uuid) from public,anon,authenticated;
grant execute on function hub.prepare_learning_receipt_mapping(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid),hub.set_learning_receipt_mapping_state(uuid,uuid,uuid,text),
  hub.provision_learning_receipt_access(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid),
  hub.ingest_learning_receipt(uuid,uuid,text,text),hub.get_learning_receipt_status(uuid,uuid) to service_role;

-- Add SMS as its own verified method; never relabel an app session as AAL2.
alter function private.require_receipt_command_actor(uuid,uuid) rename to require_receipt_totp_actor;
create function private.require_receipt_command_actor(p_actor_id uuid,p_session_id uuid) returns void
language plpgsql stable security definer set search_path='' as $$
declare actor jsonb;
begin
  if p_actor_id=(select auth.uid()) and p_session_id::text=(select auth.jwt()->>'sms_session_id')
    and private.current_app_session_verified() then
    actor:=hub.authorize_app_command();
    if actor->>'method'='sms' and actor->>'user_id'=p_actor_id::text and actor->>'session_id'=p_session_id::text then return; end if;
  end if;
  perform private.require_receipt_totp_actor(p_actor_id,p_session_id);
end;
$$;
revoke all on function private.require_receipt_command_actor(uuid,uuid),private.require_receipt_totp_actor(uuid,uuid) from public,anon,authenticated,service_role,hub_app_server;
grant execute on function hub.prepare_learning_receipt_mapping(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid),
  hub.set_learning_receipt_mapping_state(uuid,uuid,uuid,text),hub.provision_learning_receipt_access(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid),
  hub.ingest_learning_receipt(uuid,uuid,text,text),hub.get_learning_receipt_status(uuid,uuid) to hub_app_server;
alter table private.app_delegations drop constraint app_delegations_audience_check;
alter table private.app_delegations add constraint app_delegations_audience_check
  check(audience in ('carebase','breathe','caremetric-emr','pennsync','carebase.command','carebase.learning','media'));
do $$ begin
  if to_regprocedure('hub.authorize_app_command()') is null or to_regprocedure('hub.ingest_learning_receipt(uuid,uuid,text,text)') is null
    or to_regprocedure('hub.provision_learning_receipt_access(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)') is null
    or to_regclass('private.learning_receipt_inbox') is null or to_regclass('private.learning_employee_bindings') is null then
    raise exception 'Apply reviewed receipt, identity and app session migrations first'; end if;
end; $$;
create or replace function hub.get_backend_contract() returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('api_version',4,'features',jsonb_build_array('learning.runtime.v1','platform.admin.read.v1','app.sms.v1',
    'learning.sources.v1','platform.admin.command.v1','learning.receipts.v1'));
$$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- DocStudio knowledge publications use the existing catalog and access policy.
-- Only the application server can attest checked bytes or execute a commit.
create table private.publication_import_settings (
  singleton boolean primary key default true check(singleton),
  max_video_bytes integer not null default 26214400 check(max_video_bytes between 1048576 and 536870912)
);
insert into private.publication_import_settings(singleton) values(true);
create table private.publication_imports (
  id uuid primary key,
  actor_id uuid not null references auth.users(id),
  content_key text not null check(length(content_key) between 3 and 120 and content_key ~ '^[a-z0-9]+([.-][a-z0-9]+)*$'),
  manifest jsonb not null check(jsonb_typeof(manifest)='object' and octet_length(manifest::text)<=70000),
  base_snapshot jsonb,
  base_fingerprint text not null check(base_fingerprint ~ '^[0-9a-f]{64}$'),
  plan jsonb check(plan is null or (jsonb_typeof(plan)='object' and octet_length(plan::text)<=50000)),
  idempotency_key uuid unique,
  commit_request jsonb,
  receipt jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '30 minutes',
  check(expires_at>created_at and expires_at<=created_at+interval '1 hour'),
  check((receipt is null and idempotency_key is null and commit_request is null) or (receipt is not null and idempotency_key is not null and commit_request is not null))
);
create index publication_import_actor_idx on private.publication_imports(actor_id,created_at);
create index publication_import_expiry_idx on private.publication_imports(expires_at) where receipt is null;
create table private.publication_import_assets (
  import_id uuid not null references private.publication_imports(id) on delete cascade,
  part text not null check(part in ('primary','captions','transcript')),
  expected_sha256 text not null check(expected_sha256 ~ '^[0-9a-f]{64}$'),
  expected_bytes integer check(expected_bytes>0),
  max_bytes integer not null check(max_bytes between 1 and 536870912),
  content_type text not null check(content_type in ('text/markdown','video/mp4','text/vtt','text/plain')),
  byte_length integer,
  verified_at timestamptz,
  revision_id uuid references hub.content_revisions(id) on delete restrict,
  body_text text check(body_text is null or octet_length(body_text)<=2097152),
  primary key(import_id,part),
  check((verified_at is null and byte_length is null and revision_id is null and body_text is null) or (verified_at is not null and byte_length>0 and byte_length<=max_bytes)),
  check(expected_bytes is null or byte_length is null or expected_bytes=byte_length),
  check(body_text is null or (part='primary' and content_type='text/markdown'))
);
create unique index publication_import_asset_revision_idx on private.publication_import_assets(revision_id,part) where revision_id is not null;
create table private.publication_revision_provenance (
  revision_id uuid primary key references hub.content_revisions(id) on delete restrict,
  item_id uuid not null references hub.content_items(id) on delete restrict,
  revision_no integer not null check(revision_no between 1 and 100),
  source_version text not null check(source_version ~ '^docstudio-v[1-9][0-9]{0,14}$'),
  revision_identity text not null check(revision_identity ~ '^sha256:[0-9a-f]{64}$'),
  artifact_identity text not null check(artifact_identity ~ '^sha256:[0-9a-f]{64}$'),
  manifest jsonb not null,
  import_id uuid not null references private.publication_imports(id) on delete restrict,
  unique(item_id,revision_no), unique(item_id,source_version)
);
create index publication_revision_import_idx on private.publication_revision_provenance(import_id);
create table private.publication_cleanup_tokens (
  token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
  import_id uuid not null references private.publication_imports(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index publication_cleanup_import_idx on private.publication_cleanup_tokens(import_id);
create table private.publication_public_downloads (
  token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
  revision_id uuid not null references hub.content_revisions(id) on delete cascade,
  part text not null check(part in ('primary','captions','transcript')),
  byte_range text check(byte_range is null or byte_range ~ '^bytes=[0-9]{1,9}-[0-9]{1,9}$'),
  expires_at timestamptz not null default now()+interval '30 seconds'
);
create index publication_public_download_expiry_idx on private.publication_public_downloads(expires_at);
create index publication_public_download_revision_idx on private.publication_public_downloads(revision_id);
alter table private.publication_import_settings enable row level security;
alter table private.publication_imports enable row level security;
alter table private.publication_import_assets enable row level security;
alter table private.publication_revision_provenance enable row level security;
alter table private.publication_cleanup_tokens enable row level security;
alter table private.publication_public_downloads enable row level security;
revoke all on private.publication_import_settings,private.publication_imports,private.publication_import_assets,private.publication_revision_provenance,private.publication_cleanup_tokens,private.publication_public_downloads from public,anon,authenticated,service_role,hub_app_server;

create function private.require_publication_scope(p_manifest jsonb,p_key text) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare v_slug text; product uuid;
begin
  if not private.current_app_session_verified() then raise exception 'Current application session required.' using errcode='28000'; end if;
  if not exists(select 1 from private.staff_permissions where user_id=auth.uid() and revoked_at is null and permission in ('content.write','platform.admin')) then
    raise exception 'Content editor permission required.' using errcode='42501';
  end if;
  for v_slug in select distinct value->>'product_slug' from jsonb_array_elements(p_manifest->'placements') loop
    select id into product from hub.products where products.slug=v_slug and status<>'retired' and support_enabled;
    if product is null or not private.has_staff_permission('content.write',product) then raise exception 'Product editor permission required.' using errcode='42501'; end if;
  end loop;
  -- Removed and replaced products must also remain within the editor's scope.
  for product in select p.product_id from hub.content_publications p join hub.content_items i on i.id=p.item_id where i.content_key=p_key loop
    if not private.has_staff_permission('content.write',product) then raise exception 'Existing product editor permission required.' using errcode='42501'; end if;
  end loop;
  return auth.uid();
end;
$$;

create function private.publication_snapshot(p_key text,p_version text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare item hub.content_items%rowtype; latest text; revisions jsonb;
begin
  select * into item from hub.content_items where content_key=p_key;
  if item.id is null then return null; end if;
  if item.source_system<>'docstudio' or not exists(select 1 from private.publication_revision_provenance where item_id=item.id)
    or exists(select 1 from hub.content_revisions r where r.item_id=item.id and not exists(select 1 from private.publication_revision_provenance p where p.revision_id=r.id)) then
    raise exception 'This catalog key is owned by another workflow.' using errcode='P4090';
  end if;
  select source_version into latest from private.publication_revision_provenance where item_id=item.id order by revision_no desc limit 1;
  if p_version<>latest and substring(p_version from 12)::bigint<=substring(latest from 12)::bigint then
    raise exception 'Approve a higher source version.' using errcode='P4090';
  end if;
  select jsonb_agg(jsonb_build_object(
    'revision',p.revision_no,'sourceVersion',p.source_version,'revisionIdentity',p.revision_identity,'artifactIdentity',p.artifact_identity,
    'state',case when item.status='published' and exists(select 1 from hub.content_publications a where a.revision_id=p.revision_id and (a.expires_at is null or a.expires_at>now())) then 'published' else 'retired' end,
    'placements',coalesce((select jsonb_agg(jsonb_build_object('product_slug',prod.slug,'audience',cp.audience,'route_pattern',cp.route_pattern,
      'state',case when cp.expires_at is null or cp.expires_at>now() then 'active' else 'retired' end) order by prod.slug)
      from hub.content_publications cp join hub.products prod on prod.id=cp.product_id where cp.revision_id=p.revision_id),'[]'::jsonb)
  ) order by p.revision_no) into revisions from private.publication_revision_provenance p where p.item_id=item.id;
  return jsonb_build_object('contentKey',p_key,'approvedNextSourceVersion',case when p_version=latest then null else p_version end,'revisions',revisions);
end;
$$;

create function private.publication_import_access() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.require_publication_scope('{"placements":[]}'::jsonb,'');
  return jsonb_build_object('canImport',true,'maxVideoBytes',(select max_video_bytes from private.publication_import_settings where singleton));
end;
$$;
create function private.publication_catalog_fingerprint(p_key text) returns text
language sql stable security definer set search_path='' as $$
  select encode(extensions.digest(jsonb_build_object(
    'item',(select to_jsonb(i) from hub.content_items i where i.content_key=p_key),
    'revisions',(select jsonb_agg(encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') order by r.id) from hub.content_revisions r join hub.content_items i on i.id=r.item_id where i.content_key=p_key),
    'publications',(select jsonb_agg(to_jsonb(p) order by p.id) from hub.content_publications p join hub.content_items i on i.id=p.item_id where i.content_key=p_key),
    'media',(select jsonb_agg(to_jsonb(m) order by m.id) from hub.media_assets m join hub.content_items i on i.id=m.content_item_id where i.content_key=p_key)
  )::text,'sha256'),'hex');
$$;
create function private.stage_publication_import(p_id uuid,p_manifest jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid; key text:=p_manifest#>>'{source,content_key}'; snapshot jsonb; maximum integer; part text;
begin
  if octet_length(p_manifest::text)>70000 or p_manifest->>'schema_version'<>'caremetric.support-hub.publication.v1'
    or p_manifest->>'source_system'<>'docstudio' or coalesce(p_manifest#>>'{source,version}','') !~ '^docstudio-v[1-9][0-9]{0,14}$'
    or coalesce(p_manifest#>>'{content,kind}','') not in ('article','video') or coalesce(p_manifest#>>'{content,access_level}','') not in ('public','customer','staff')
    or jsonb_typeof(p_manifest->'placements') is distinct from 'array' or jsonb_array_length(p_manifest->'placements')>6
    or coalesce(p_manifest#>>'{artifact,byte_length}','') !~ '^[1-9][0-9]{0,8}$'
    or coalesce(p_manifest#>>'{artifact,sha256}','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_manifest#>>'{governance,review_state}','')<>'approved' or coalesce(p_manifest#>>'{governance,phi_review}','')<>'passed' then
    raise exception 'Invalid publication manifest.' using errcode='22023';
  end if;
  actor:=private.require_publication_scope(p_manifest,key);
  perform pg_advisory_xact_lock(hashtextextended('publication_import_limits',0));
  if (select count(*) from private.publication_imports where receipt is null and expires_at>now())>=12
    or (select count(*) from private.publication_imports where actor_id=actor and receipt is null and expires_at>now())>=3
    or (select count(*) from private.publication_imports where created_at>now()-interval '1 hour')>=100 then
    raise exception 'Publication import limit reached.' using errcode='P4290';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('publication:'||key,0));
  snapshot:=private.publication_snapshot(key,p_manifest#>>'{source,version}');
  if snapshot is null and jsonb_array_length(p_manifest->'placements')=0 then raise exception 'New content requires a product.' using errcode='22023'; end if;
  if exists(select 1 from hub.content_items where content_key=key and (kind::text<>p_manifest#>>'{content,kind}' or default_locale<>p_manifest#>>'{content,locale}')) then
    raise exception 'A stable content key cannot change kind or locale.' using errcode='P4090';
  end if;
  maximum:=case when p_manifest#>>'{content,kind}'='video' then (select max_video_bytes from private.publication_import_settings where singleton) else 2097152 end;
  if (p_manifest#>>'{artifact,byte_length}')::integer>maximum then raise exception 'Publication exceeds storage limit.' using errcode='P4130'; end if;
  if p_manifest#>>'{content,kind}'='video' and ((p_manifest#>>'{artifact,duration_ms}')::numeric>2147483647) then raise exception 'Video duration exceeds catalog limit.' using errcode='22023'; end if;
  insert into private.publication_imports(id,actor_id,content_key,manifest,base_snapshot,base_fingerprint) values(p_id,actor,key,p_manifest,snapshot,private.publication_catalog_fingerprint(key));
  insert into private.publication_import_assets(import_id,part,expected_sha256,expected_bytes,max_bytes,content_type)
    values(p_id,'primary',p_manifest#>>'{artifact,sha256}',(p_manifest#>>'{artifact,byte_length}')::integer,maximum,p_manifest#>>'{artifact,media_type}');
  foreach part in array array['captions','transcript'] loop
    if p_manifest->'artifact' ? (part||'_sha256') then
      insert into private.publication_import_assets(import_id,part,expected_sha256,max_bytes,content_type)
        values(p_id,part,p_manifest->'artifact'->>(part||'_sha256'),10485760,case when part='captions' then 'text/vtt' else 'text/plain' end);
    end if;
  end loop;
end;
$$;

create function private.require_publication_import(p_id uuid,p_allow_committed boolean default false) returns private.publication_imports
language plpgsql stable security definer set search_path='' as $$
declare intent private.publication_imports;
begin
  select * into intent from private.publication_imports where id=p_id;
  if intent.id is null or intent.actor_id is distinct from auth.uid() or (intent.receipt is null and intent.expires_at<=now()) then raise exception 'Import unavailable.' using errcode='P4040'; end if;
  perform private.require_publication_scope(intent.manifest,intent.content_key);
  if intent.receipt is not null and not p_allow_committed then raise exception 'Import already committed.' using errcode='P4090'; end if;
  return intent;
end;
$$;
create function private.get_publication_import(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare intent private.publication_imports;
begin
  intent:=private.require_publication_import(p_id);
  return jsonb_build_object('id',intent.id,'expiresAt',intent.expires_at,'manifest',intent.manifest,'plan',intent.plan,
    'uploadedParts',coalesce((select jsonb_agg(part order by part) from private.publication_import_assets where import_id=p_id and verified_at is not null),'[]'::jsonb));
end;
$$;
create function private.get_publication_import_context(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare intent private.publication_imports;
begin
  intent:=private.require_publication_import(p_id);
  if private.publication_catalog_fingerprint(intent.content_key)<>intent.base_fingerprint or private.publication_snapshot(intent.content_key,intent.manifest#>>'{source,version}') is distinct from intent.base_snapshot then raise exception 'Stale publication preview.' using errcode='P4090'; end if;
  return jsonb_build_object('manifest',intent.manifest,'existing',intent.base_snapshot,'assets',
    (select jsonb_agg(jsonb_build_object('part',part,'sha256',expected_sha256,'byteLength',byte_length,'verified',verified_at is not null) order by part) from private.publication_import_assets where import_id=p_id));
end;
$$;
create function private.verify_publication_asset(p_id uuid,p_part text,p_sha256 text,p_bytes integer,p_text text) returns void
language plpgsql security definer set search_path='' as $$
declare asset private.publication_import_assets;
begin
  perform 1 from private.publication_imports where id=p_id for update;
  perform private.require_publication_import(p_id);
  select * into asset from private.publication_import_assets where import_id=p_id and part=p_part for update;
  if asset.part is null or asset.expected_sha256<>p_sha256 or p_bytes<=0 or p_bytes>asset.max_bytes
    or (asset.expected_bytes is not null and asset.expected_bytes<>p_bytes)
    or ((asset.content_type='text/markdown') is distinct from (p_text is not null))
    or (p_text is not null and (octet_length(p_text)<>p_bytes or encode(extensions.digest(convert_to(p_text,'UTF8'),'sha256'),'hex')<>p_sha256)) then
    raise exception 'Asset verification failed.' using errcode='22023';
  end if;
  if asset.verified_at is not null then
    if asset.byte_length<>p_bytes or asset.body_text is distinct from p_text then raise exception 'Verified asset is immutable.' using errcode='P4090'; end if;
    return;
  end if;
  update private.publication_import_assets set byte_length=p_bytes,verified_at=clock_timestamp(),body_text=p_text where import_id=p_id and part=p_part;
end;
$$;
create function private.store_publication_preview(p_id uuid,p_plan jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare intent private.publication_imports;
begin
  perform 1 from private.publication_imports where id=p_id for update;
  intent:=private.require_publication_import(p_id);
  if private.publication_catalog_fingerprint(intent.content_key)<>intent.base_fingerprint or private.publication_snapshot(intent.content_key,intent.manifest#>>'{source,version}') is distinct from intent.base_snapshot then raise exception 'Stale publication preview.' using errcode='P4090'; end if;
  if exists(select 1 from private.publication_import_assets where import_id=p_id and verified_at is null)
    or p_plan->>'contentKey'<>intent.content_key or p_plan->>'mode'<>'preview'
    or p_plan->>'schemaVersion'<>'caremetric.support-hub.import-plan.v1'
    or coalesce(p_plan->>'planIdentity','') !~ '^sha256:[0-9a-f]{64}$'
    or coalesce(p_plan->>'revisionIdentity','') !~ '^sha256:[0-9a-f]{64}$'
    or p_plan->>'artifactIdentity'<>'sha256:'||(intent.manifest#>>'{artifact,sha256}') then raise exception 'Invalid verified plan.' using errcode='22023'; end if;
  if intent.plan is not null and intent.plan<>p_plan then raise exception 'Preview is immutable.' using errcode='P4090'; end if;
  update private.publication_imports set plan=p_plan where id=p_id;
end;
$$;

create function private.commit_publication_import(p_id uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.publication_imports; key uuid; expected jsonb; supplied jsonb; item uuid; revision uuid; v_revision_no integer;
  previous_no integer; place jsonb; product uuid; primary_asset private.publication_import_assets; outcome text; v_receipt jsonb;
begin
  -- Current identity/scope is checked even for an idempotent replay.
  intent:=private.require_publication_import(p_id,true);
  if (select array_agg(k order by k) from jsonb_object_keys(p_request) k) is distinct from array['confirmedActions','idempotencyKey','planIdentity','reviewConfirmed']::text[] then raise exception 'Invalid commit fields.' using errcode='22023'; end if;
  key:=(p_request->>'idempotencyKey')::uuid;
  perform pg_advisory_xact_lock(hashtextextended('publication_commit:'||key::text,0));
  perform pg_advisory_xact_lock(hashtextextended('publication:'||intent.content_key,0));
  select * into intent from private.publication_imports where id=p_id for update;
  perform private.require_publication_import(p_id,true);
  if intent.receipt is not null then
    if intent.idempotency_key=key and intent.commit_request=p_request then return intent.receipt; end if;
    raise exception 'Idempotency key or request changed.' using errcode='P4090';
  end if;
  if exists(select 1 from private.publication_imports where idempotency_key=key) then raise exception 'Idempotency key was already used.' using errcode='P4090'; end if;
  if intent.plan is null or p_request->>'planIdentity' is distinct from intent.plan->>'planIdentity' or p_request->'reviewConfirmed' is distinct from 'true'::jsonb
    or jsonb_typeof(p_request->'confirmedActions') is distinct from 'array' then raise exception 'Exact reviewed plan required.' using errcode='22023'; end if;
  select coalesce(jsonb_agg((position-1)::text||':'||(action->>'type') order by (position-1)::text||':'||(action->>'type')),'[]'::jsonb) into expected
    from jsonb_array_elements(intent.plan->'actions') with ordinality actions(action,position) where action->'requiresExplicitApproval'='true'::jsonb;
  select coalesce(jsonb_agg(value order by value),'[]'::jsonb) into supplied from jsonb_array_elements_text(p_request->'confirmedActions');
  if expected<>supplied then raise exception 'Every replacement and retirement requires confirmation.' using errcode='22023'; end if;
  if private.publication_catalog_fingerprint(intent.content_key)<>intent.base_fingerprint or private.publication_snapshot(intent.content_key,intent.manifest#>>'{source,version}') is distinct from intent.base_snapshot then raise exception 'Stale publication preview.' using errcode='P4090'; end if;
  if exists(select 1 from private.publication_import_assets where import_id=p_id and verified_at is null) then raise exception 'Verify every asset before publishing.' using errcode='22023'; end if;
  select id into item from hub.content_items where content_key=intent.content_key;
  select coalesce(max(p.revision_no),0) into previous_no from private.publication_revision_provenance p where p.item_id=item;
  v_revision_no:=(intent.plan->>'targetRevision')::integer;
  if v_revision_no not between 1 and 100 or v_revision_no not in (previous_no,previous_no+1) then raise exception 'Invalid next revision.' using errcode='22023'; end if;
  if item is null then
    insert into hub.content_items(content_key,kind,status,access_level,default_locale,source_system,created_by)
      values(intent.content_key,(intent.manifest#>>'{content,kind}')::hub.content_kind,'draft',(intent.manifest#>>'{content,access_level}')::hub.access_level,intent.manifest#>>'{content,locale}','docstudio',auth.uid()) returning id into item;
  end if;
  if v_revision_no=previous_no then
    select p.revision_id into revision from private.publication_revision_provenance p where p.item_id=item and p.revision_no=v_revision_no and p.revision_identity=intent.plan->>'revisionIdentity';
    if revision is null then raise exception 'Existing revision is immutable.' using errcode='P4090'; end if;
  else
    select * into primary_asset from private.publication_import_assets where import_id=p_id and part='primary';
    insert into hub.content_revisions(item_id,revision_no,locale,title,summary,body_markdown,body_text,source_hash,source_version,review_state,created_by,approved_by,approved_at)
      values(item,v_revision_no,intent.manifest#>>'{content,locale}',intent.manifest#>>'{content,title}',intent.manifest#>>'{content,summary}',primary_asset.body_text,primary_asset.body_text,
        intent.plan->>'revisionIdentity',intent.manifest#>>'{source,version}','approved',auth.uid(),auth.uid(),clock_timestamp()) returning id into revision;
    insert into private.publication_revision_provenance(revision_id,item_id,revision_no,source_version,revision_identity,artifact_identity,manifest,import_id)
      values(revision,item,v_revision_no,intent.manifest#>>'{source,version}',intent.plan->>'revisionIdentity',intent.plan->>'artifactIdentity',intent.manifest,p_id);
    update private.publication_import_assets set revision_id=revision where import_id=p_id;
    if intent.manifest#>>'{content,kind}'='video' then
      insert into hub.media_assets(content_item_id,revision_id,renderer,storage_provider,storage_key,mime_type,sha256,duration_ms,caption_storage_key,transcript_storage_key,render_status,data_classification,access_level,input_hash,published_at)
        values(item,revision,'docstudio','supabase','publications/'||p_id||'/primary','video/mp4',primary_asset.expected_sha256,(intent.manifest#>>'{artifact,duration_ms}')::integer,
          case when intent.manifest->'artifact' ? 'captions_sha256' then 'publications/'||p_id||'/captions' end,
          case when intent.manifest->'artifact' ? 'transcript_sha256' then 'publications/'||p_id||'/transcript' end,
          'ready','none',(intent.manifest#>>'{content,access_level}')::hub.access_level,intent.plan->>'revisionIdentity',clock_timestamp());
    end if;
  end if;
  outcome:=case when intent.plan->'actions' @> '[{"type":"no_op"}]'::jsonb then 'unchanged' when jsonb_array_length(intent.manifest->'placements')=0 then 'retired' else 'published' end;
  if outcome<>'unchanged' then
    update hub.content_publications cp set expires_at=clock_timestamp() where cp.item_id=item and (cp.expires_at is null or cp.expires_at>now())
      and not exists(select 1 from jsonb_array_elements(intent.manifest->'placements') a join hub.products p on p.slug=a->>'product_slug' where p.id=cp.product_id);
    for place in select value from jsonb_array_elements(intent.manifest->'placements') loop
      select id into product from hub.products where slug=place->>'product_slug';
      insert into hub.content_publications(item_id,revision_id,product_id,audience,route_pattern,published_by,published_at)
        values(item,revision,product,array(select jsonb_array_elements_text(place->'audience')),place->>'route_pattern',auth.uid(),clock_timestamp())
        on conflict(item_id,product_id) do update set revision_id=excluded.revision_id,audience=excluded.audience,route_pattern=excluded.route_pattern,published_by=excluded.published_by,published_at=excluded.published_at,expires_at=null;
    end loop;
    update hub.content_items set status=case when outcome='retired' then 'retired'::hub.content_status else 'published'::hub.content_status end,
      access_level=(intent.manifest#>>'{content,access_level}')::hub.access_level,retired_at=case when outcome='retired' then clock_timestamp() end,updated_at=clock_timestamp() where id=item;
  end if;
  v_receipt:=jsonb_build_object('importId',p_id,'itemId',item,'revisionId',revision,'revision',v_revision_no,'planIdentity',intent.plan->>'planIdentity','committedAt',clock_timestamp(),'outcome',outcome);
  update private.publication_imports set idempotency_key=key,commit_request=p_request,receipt=v_receipt where id=p_id;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,changed_columns,metadata)
    values(auth.uid(),'publication.import_committed','content_revision',revision,array['content','placements'],jsonb_build_object('import_id',p_id,'revision',v_revision_no,'outcome',outcome,'plan_identity',intent.plan->>'planIdentity'));
  return v_receipt;
end;
$$;

create function private.publication_object(p_id uuid,p_part text,p_operation text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare asset private.publication_import_assets; intent private.publication_imports;
begin
  if not private.current_app_session_verified() then raise exception 'Current application session required.' using errcode='28000'; end if;
  if p_operation='upload' then
    intent:=private.require_publication_import(p_id);
    select * into asset from private.publication_import_assets where import_id=p_id and part=p_part and verified_at is null;
  elsif p_operation='download' then
    select * into asset from private.publication_import_assets where revision_id=p_id and part=p_part and verified_at is not null;
    if asset.import_id is not null and not exists(select 1 from hub.content_publications p
      where p.revision_id=p_id and p.published_at<=now() and (p.expires_at is null or p.expires_at>now())
        and private.can_access_content_publication(p.item_id,p.revision_id,p.product_id)) then
      raise exception 'Publication access denied.' using errcode='42501';
    end if;
  else raise exception 'Unsupported publication operation.' using errcode='22023'; end if;
  if asset.import_id is null then raise exception 'Publication asset unavailable.' using errcode='P4040'; end if;
  return jsonb_build_object('path','publications/'||asset.import_id||'/'||asset.part,'operation',p_operation,'contentType',asset.content_type,
    'sha256',asset.expected_sha256,'byteLength',case when p_operation='download' then asset.byte_length else asset.expected_bytes end,'maxBytes',asset.max_bytes);
end;
$$;

create function private.publication_media_info(p_revision uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare asset jsonb;
begin
  asset:=private.publication_object(p_revision,'primary','download');
  return jsonb_build_object('contentType',asset->>'contentType',
    'hasCaptions',exists(select 1 from private.publication_import_assets where revision_id=p_revision and part='captions'),
    'hasTranscript',exists(select 1 from private.publication_import_assets where revision_id=p_revision and part='transcript'));
end;
$$;

-- Public Help uses a separate actor-free download authority. Even when invoked
-- on a connection carrying staff claims, evaluate the current policy as anon.
create function private.publication_public_object(p_revision uuid,p_part text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare asset private.publication_import_assets; previous_claims text;
begin
  if session_user<>'hub_app_server' then raise exception 'Application server required.' using errcode='42501'; end if;
  previous_claims:=current_setting('request.jwt.claims',true);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  select a.* into asset from private.publication_import_assets a
    where a.revision_id=p_revision and a.part=p_part and a.verified_at is not null;
  if asset.import_id is null then raise exception 'Publication asset unavailable.' using errcode='P4040'; end if;
  if not exists(select 1 from hub.content_publications p join hub.content_items i on i.id=p.item_id
    where p.revision_id=p_revision and i.access_level='public'
      and private.can_access_content_publication(p.item_id,p.revision_id,p.product_id)) then
    raise exception 'Public publication access denied.' using errcode='42501';
  end if;
  perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);
  return jsonb_build_object('path','publications/'||asset.import_id||'/'||asset.part,'operation','download','contentType',asset.content_type,
    'sha256',asset.expected_sha256,'byteLength',asset.byte_length,'maxBytes',asset.max_bytes);
end;
$$;
create function private.publication_public_media_info(p_revision uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare asset jsonb;
begin
  asset:=private.publication_public_object(p_revision,'primary');
  return jsonb_build_object('contentType',asset->>'contentType',
    'hasCaptions',exists(select 1 from private.publication_import_assets where revision_id=p_revision and part='captions'),
    'hasTranscript',exists(select 1 from private.publication_import_assets where revision_id=p_revision and part='transcript'));
end;
$$;
create function private.issue_publication_public_download(p_hash text,p_revision uuid,p_part text,p_range text) returns void
language plpgsql security definer set search_path='' as $$
declare asset jsonb; bounds text[];
begin
  asset:=private.publication_public_object(p_revision,p_part);
  if p_range is not null then
    bounds:=regexp_match(p_range,'^bytes=([0-9]{1,9})-([0-9]{1,9})$');
    if bounds is null or bounds[1]::integer>bounds[2]::integer or bounds[2]::integer>=(asset->>'byteLength')::integer then
      raise exception 'Invalid public download range.' using errcode='22023';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('publication_public_downloads',0));
  delete from private.publication_public_downloads where expires_at<=now();
  if (select count(*) from private.publication_public_downloads)>=2000 then raise exception 'Public download capacity reached.' using errcode='P4290'; end if;
  insert into private.publication_public_downloads(token_hash,revision_id,part,byte_range) values(p_hash,p_revision,p_part,p_range);
end;
$$;
create function private.consume_publication_public_download(p_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ticket private.publication_public_downloads; asset jsonb;
begin
  if session_user<>'hub_app_server' then raise exception 'Application server required.' using errcode='42501'; end if;
  delete from private.publication_public_downloads where token_hash=p_hash and expires_at>now() returning * into ticket;
  if ticket.token_hash is null then raise exception 'Public download ticket unavailable.' using errcode='28000'; end if;
  asset:=private.publication_public_object(ticket.revision_id,ticket.part);
  return asset||jsonb_build_object('range',ticket.byte_range);
end;
$$;
revoke all on function private.publication_public_object(uuid,text),private.publication_public_media_info(uuid),private.issue_publication_public_download(text,uuid,text,text),private.consume_publication_public_download(text) from public,anon,authenticated,service_role;
grant execute on function private.publication_public_object(uuid,text),private.publication_public_media_info(uuid),private.issue_publication_public_download(text,uuid,text,text),private.consume_publication_public_download(text) to hub_app_server;

-- Cleanup authority comes only from a short-lived one-use server maintenance
-- ticket naming an expired intent whose objects are not attached to a revision.
create function private.issue_publication_cleanup(p_hash text) returns uuid
language plpgsql security definer set search_path='' as $$
declare intent uuid;
begin
  if session_user<>'hub_app_server' then raise exception 'Server maintenance required.' using errcode='42501'; end if;
  delete from private.publication_cleanup_tokens where expires_at<=now();
  -- No transfer can outlive the fixed 120s Node/110s Edge deadline. The grace
  -- prevents deleting a key while a pre-expiry authorized upload is finishing.
  select i.id into intent from private.publication_imports i where i.expires_at<now()-interval '5 minutes'
    and not exists(select 1 from private.publication_import_assets a where a.import_id=i.id and a.revision_id is not null)
    and not exists(select 1 from private.publication_cleanup_tokens t where t.import_id=i.id and t.expires_at>now())
    and exists(select 1 from private.publication_import_assets a where a.import_id=i.id)
    order by i.expires_at limit 1 for update skip locked;
  if intent is null then return null; end if;
  insert into private.publication_cleanup_tokens(token_hash,import_id,expires_at) values(p_hash,intent,now()+interval '5 minutes');
  return intent;
end;
$$;
create function private.consume_publication_cleanup(p_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent uuid; paths jsonb;
begin
  if session_user<>'hub_app_server' then raise exception 'Server maintenance required.' using errcode='42501'; end if;
  update private.publication_cleanup_tokens t set consumed_at=now() where t.token_hash=p_hash and t.expires_at>now() and t.consumed_at is null
    and exists(select 1 from private.publication_imports i where i.id=t.import_id and i.expires_at<now()-interval '5 minutes')
    and not exists(select 1 from private.publication_import_assets a where a.import_id=t.import_id and a.revision_id is not null)
    returning import_id into intent;
  if intent is null then raise exception 'Cleanup ticket unavailable.' using errcode='28000'; end if;
  select jsonb_agg('publications/'||intent||'/'||part order by part) into paths from private.publication_import_assets where import_id=intent;
  return jsonb_build_object('operation','cleanup','paths',paths);
end;
$$;
create function private.finish_publication_cleanup(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if session_user<>'hub_app_server' then raise exception 'Server maintenance required.' using errcode='42501'; end if;
  if not exists(select 1 from private.publication_cleanup_tokens where import_id=p_id and consumed_at is not null and expires_at>now()) then raise exception 'Cleanup ticket required.' using errcode='42501'; end if;
  delete from private.publication_import_assets where import_id=p_id and revision_id is null;
  -- Keep commit receipts permanently, even when an unchanged import used no bytes.
  delete from private.publication_imports where id=p_id and receipt is null and expires_at<now()
    and not exists(select 1 from private.publication_import_assets where import_id=p_id);
end;
$$;

create function private.protect_publication_revision() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_table_schema='private' then
    raise exception 'Published DocStudio revision is immutable.' using errcode='42501';
  end if;
  if exists(select 1 from private.publication_revision_provenance where revision_id=old.id) then
    raise exception 'Published DocStudio revision is immutable.' using errcode='42501';
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
create trigger publication_provenance_immutable before update or delete on private.publication_revision_provenance for each row execute function private.protect_publication_revision();
create trigger publication_revision_immutable before update or delete on hub.content_revisions for each row execute function private.protect_publication_revision();

create function private.protect_publication_asset() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    if old.revision_id is not null then raise exception 'Published asset is immutable.' using errcode='42501'; end if;
    return old;
  end if;
  if old.verified_at is not null and (new.import_id<>old.import_id or new.part<>old.part or new.expected_sha256<>old.expected_sha256
    or new.expected_bytes is distinct from old.expected_bytes or new.max_bytes<>old.max_bytes or new.content_type<>old.content_type
    or new.byte_length is distinct from old.byte_length or new.body_text is distinct from old.body_text or new.verified_at is distinct from old.verified_at
    or (old.revision_id is not null and new.revision_id is distinct from old.revision_id)) then
    raise exception 'Verified asset is immutable.' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger publication_asset_immutable before update or delete on private.publication_import_assets for each row execute function private.protect_publication_asset();
create function private.lock_publication_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare item uuid; content_key text;
begin
  item:=case when tg_op='DELETE' then old.item_id else new.item_id end;
  select i.content_key into content_key from hub.content_items i where i.id=item;
  if exists(select 1 from private.publication_revision_provenance where item_id=item) then
    perform pg_advisory_xact_lock(hashtextextended('publication:'||content_key,0));
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
create trigger publication_change_lock before insert or update or delete on hub.content_publications for each row execute function private.lock_publication_change();

-- Storage remains private. No browser INSERT/UPDATE/DELETE policy is granted;
-- the fixed Edge transport uses its own credential after consuming a capability.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('hub-publications','hub-publications',false,536870912,array['text/markdown','video/mp4','text/vtt','text/plain'])
  on conflict(id) do nothing;
-- A future broad permissive Storage policy must not expose staging objects.
create policy publication_objects_private on storage.objects as restrictive for all to anon,authenticated
  using(bucket_id<>'hub-publications') with check(bucket_id<>'hub-publications');
alter table private.app_delegations drop constraint app_delegations_audience_check;
alter table private.app_delegations add constraint app_delegations_audience_check check(audience in ('carebase','media','breathe','caremetric-emr','caremetric-go','pennsync','intel','carebase.command','carebase.learning','publication'));

-- Helpers are not generic RPCs. The connection role invokes them only after
-- installing the current app session's claims; each function rechecks authority.
revoke all on function private.require_publication_scope(jsonb,text),private.publication_snapshot(text,text),private.publication_import_access(),private.stage_publication_import(uuid,jsonb),
  private.require_publication_import(uuid,boolean),private.get_publication_import(uuid),private.get_publication_import_context(uuid),private.verify_publication_asset(uuid,text,text,integer,text),
  private.store_publication_preview(uuid,jsonb),private.commit_publication_import(uuid,jsonb),private.publication_object(uuid,text,text),private.publication_media_info(uuid),private.issue_publication_cleanup(text),
  private.consume_publication_cleanup(text),private.finish_publication_cleanup(uuid),private.protect_publication_revision(),private.protect_publication_asset(),private.lock_publication_change(),private.publication_catalog_fingerprint(text) from public,anon,authenticated,service_role;
grant execute on function private.publication_import_access(),private.stage_publication_import(uuid,jsonb),private.get_publication_import(uuid),private.get_publication_import_context(uuid),
  private.verify_publication_asset(uuid,text,text,integer,text),private.store_publication_preview(uuid,jsonb),private.commit_publication_import(uuid,jsonb),private.publication_object(uuid,text,text),private.publication_media_info(uuid),
  private.issue_publication_cleanup(text),private.consume_publication_cleanup(text),private.finish_publication_cleanup(uuid) to hub_app_server;

-- 20260911181026_hub_go_admin_audience.sql
-- Go shares EMR's native data authority but must never consume its capability.
-- Preserve existing readers, command, learning and media audiences.
alter table private.app_delegations drop constraint app_delegations_audience_check;
alter table private.app_delegations add constraint app_delegations_audience_check
  check(audience in ('carebase','breathe','caremetric-emr','pennsync','caremetric-go',
    'carebase.command','carebase.learning','publication','media'));

-- 20260911181309_learning_authoring_intents.sql
-- The Hub pins reviewed source evidence; CareBase remains the only native
-- version/publication writer. No learner, credit or certificate rows are copied.
create table private.learning_authoring_intents (
  command_id uuid primary key,
  actor_id uuid not null references hub.profiles(id),
  session_id uuid not null references private.sms_sessions(id),
  snapshot_id uuid not null references private.learning_source_snapshots(id),
  preview_digest text not null check(preview_digest ~ '^[0-9a-f]{64}$'),
  preview jsonb not null check(octet_length(preview::text)<=32000),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  result jsonb check(octet_length(result::text)<=8000),
  completed_at timestamptz,
  check((result is null)=(completed_at is null))
);
create index learning_authoring_intents_actor_idx on private.learning_authoring_intents(actor_id);
create index learning_authoring_intents_session_idx on private.learning_authoring_intents(session_id);
create index learning_authoring_intents_snapshot_idx on private.learning_authoring_intents(snapshot_id);
alter table private.learning_authoring_intents enable row level security;
revoke all on private.learning_authoring_intents from public,anon,authenticated;

create function hub.remember_learning_authoring_preview(p_snapshot_id uuid,p_preview jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; source private.learning_source_snapshots%rowtype; prior private.learning_authoring_intents%rowtype;
  v_command_id uuid; expires timestamptz; head_id uuid;
begin
  actor:=hub.authorize_app_command();
  perform private.require_learning_editor();
  if p_preview is null or jsonb_typeof(p_preview)<>'object' or octet_length(p_preview::text)>32000
    or not(p_preview ?& array['commandId','courseId','action','reason','previewDigest','expiresAt','before','after'])
    or p_preview-array['commandId','courseId','action','reason','previewDigest','expiresAt','before','after']<>'{}'::jsonb
    or coalesce(p_preview->>'action','') not in ('learning.cloneVersion','learning.publishVersion')
    or coalesce(p_preview->>'previewDigest','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_preview->'before')<>'object' or jsonb_typeof(p_preview->'after')<>'object'
    or coalesce(length(p_preview->>'reason'),0) not between 10 and 500 then
    raise exception 'Invalid course preview.' using errcode='22023';
  end if;
  begin v_command_id:=(p_preview->>'commandId')::uuid; expires:=(p_preview->>'expiresAt')::timestamptz;
  exception when others then raise exception 'Invalid course preview identity.' using errcode='22023'; end;
  if v_command_id is null or expires is null or not isfinite(expires) or expires>clock_timestamp()+interval '5 minutes 5 seconds' then
    raise exception 'Invalid course preview lifetime.' using errcode='22023';
  end if;
  select * into source from private.learning_source_snapshots where id=p_snapshot_id;
  if not found or (p_preview->>'courseId')::uuid is distinct from source.source_course_id
    or (p_preview->'before'->>'courseId')::uuid is distinct from source.source_course_id
    or (p_preview->'before'->>'versionId')::uuid is distinct from source.source_version_id
    or p_preview->'before'->>'sourceRevision' is distinct from source.source_revision then
    raise exception 'The preview does not match the reviewed source.' using errcode='40001';
  end if;
  -- Serialize against source staging. A first preview must pin the current head.
  perform 1 from hub.content_items where id=source.item_id for update;
  select id into head_id from private.learning_source_snapshots where source_course_id=source.source_course_id order by sequence desc limit 1;
  select * into prior from private.learning_authoring_intents where learning_authoring_intents.command_id=v_command_id;
  if found then
    if prior.actor_id is distinct from (actor->>'user_id')::uuid or prior.session_id is distinct from (actor->>'session_id')::uuid
      or prior.snapshot_id is distinct from p_snapshot_id or prior.preview is distinct from p_preview then
      raise exception 'This command belongs to a different preview.' using errcode='40001';
    end if;
    return prior.preview;
  end if;
  if head_id is distinct from p_snapshot_id or expires<=clock_timestamp() then
    raise exception 'The preview or reviewed source changed. Refresh it.' using errcode='40001';
  end if;
  insert into private.learning_authoring_intents(command_id,actor_id,session_id,snapshot_id,preview_digest,preview,expires_at)
    values(v_command_id,(actor->>'user_id')::uuid,(actor->>'session_id')::uuid,p_snapshot_id,p_preview->>'previewDigest',p_preview,expires);
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values((actor->>'user_id')::uuid,'learning.authoring.preview','content_item',source.item_id,
      jsonb_build_object('command_id',v_command_id,'snapshot_id',source.id,'source_revision',source.source_revision));
  return p_preview;
end;
$$;

create function hub.get_learning_authoring_intent(p_command_id uuid,p_expected_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; intent private.learning_authoring_intents%rowtype;
begin
  actor:=hub.authorize_app_command();
  perform private.require_learning_editor();
  select * into intent from private.learning_authoring_intents where command_id=p_command_id;
  if not found or intent.actor_id is distinct from (actor->>'user_id')::uuid or intent.session_id is distinct from (actor->>'session_id')::uuid then
    raise exception 'This course preview is unavailable.' using errcode='42501';
  end if;
  if p_expected_digest is distinct from intent.preview_digest then
    raise exception 'The course preview changed.' using errcode='40001';
  end if;
  -- Immutable source snapshots cannot be overwritten. Native CAS checks the
  -- current source before the first write; native replay checks current authority.
  return jsonb_build_object('preview',intent.preview,'result',intent.result);
end;
$$;

create function hub.record_learning_authoring_result(p_command_id uuid,p_expected_digest text,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.learning_authoring_intents%rowtype; actor jsonb; source_item uuid;
begin
  actor:=hub.authorize_app_command();
  perform hub.get_learning_authoring_intent(p_command_id,p_expected_digest);
  select * into intent from private.learning_authoring_intents where command_id=p_command_id for update;
  if p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>8000
    or not(p_result ?& array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed'])
    or p_result-array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed']<>'{}'::jsonb
    or p_result->>'commandId' is distinct from intent.preview->>'commandId'
    or p_result->>'courseId' is distinct from intent.preview->>'courseId'
    or p_result->>'action' is distinct from intent.preview->>'action'
    or p_result->>'status' is distinct from intent.preview->'after'->>'status'
    or p_result->'versionNumber' is distinct from intent.preview->'after'->'versionNumber'
    or coalesce(p_result->>'versionId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or jsonb_typeof(p_result->'replayed') is distinct from 'boolean'
    or (p_result->>'action'='learning.publishVersion' and p_result->>'versionId' is distinct from intent.preview->'before'->>'versionId') then
    raise exception 'The native outcome does not match the preview.' using errcode='22023';
  end if;
  if intent.result is not null then
    if intent.result-'replayed' is distinct from p_result-'replayed' then
      raise exception 'The native result changed.' using errcode='40001';
    end if;
    return intent.result||jsonb_build_object('replayed',true);
  end if;
  update private.learning_authoring_intents set result=p_result,completed_at=now() where command_id=p_command_id;
  select item_id into source_item from private.learning_source_snapshots where id=intent.snapshot_id;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values((actor->>'user_id')::uuid,'learning.authoring.applied','content_item',source_item,
      jsonb_build_object('command_id',p_command_id,'action',p_result->>'action','version_id',p_result->>'versionId'));
  return p_result;
end;
$$;
revoke all on function hub.remember_learning_authoring_preview(uuid,jsonb),hub.get_learning_authoring_intent(uuid,text),hub.record_learning_authoring_result(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function hub.remember_learning_authoring_preview(uuid,jsonb),hub.get_learning_authoring_intent(uuid,text),hub.record_learning_authoring_result(uuid,text,jsonb) to authenticated;

-- 20260911182857_support_intake_readiness.sql
-- Readiness is measured from current access, not static rollout labels.
-- This migration grants no memberships and enables no customer intake.
create function private.support_usable_member_count(p_tenant uuid,p_product uuid) returns bigint
language sql stable security definer set search_path='' as $$
  select count(*) from hub.tenant_product_memberships m
  join hub.profiles profile on profile.id=m.user_id
  join auth.users u on u.id=m.user_id
  join private.sms_identities sms on sms.user_id=m.user_id
  where m.tenant_id=p_tenant and m.product_id=p_product
    and m.status='active' and m.revoked_at is null
    and u.deleted_at is null and not coalesce(u.is_anonymous,false)
    and (u.banned_until is null or u.banned_until<=now())
    and sms.verified_at is not null and sms.revoked_at is null;
$$;
revoke all on function private.support_usable_member_count(uuid,uuid) from public,anon,authenticated;

create function hub.get_support_readiness() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform hub.authorize_app_admin();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'slug',p.slug,'name',p.name,'status',p.status,'supportEnabled',p.support_enabled,
    'activeTenantCount',(select count(*) from hub.tenant_products tp join hub.tenants t on t.id=tp.tenant_id
      where tp.product_id=p.id and tp.status='active' and t.status='active'),
    'usableMemberCount',(select coalesce(sum(private.support_usable_member_count(tp.tenant_id,p.id)),0)
      from hub.tenant_products tp join hub.tenants t on t.id=tp.tenant_id
      where tp.product_id=p.id and tp.status='active' and t.status='active'),
    'readyTenantCount',(select count(*) from hub.tenant_products tp where tp.product_id=p.id
      and private.is_case_intake_enabled(tp.tenant_id,p.id)
      and private.support_usable_member_count(tp.tenant_id,p.id)>0),
    'publishedItemCount',(select count(distinct publication.item_id) from hub.content_publications publication
      join hub.content_items item on item.id=publication.item_id
      join hub.content_revisions revision on revision.id=publication.revision_id
      where publication.product_id=p.id and item.status='published' and revision.review_state='approved'
        and publication.published_at<=now() and (publication.expires_at is null or publication.expires_at>now()))
  ) order by p.name),'[]'::jsonb) into result
  from hub.products p where p.slug in ('carebase','breathe','caremetric-emr','pennsync','caremetric-intel','caremetric-go');
  return jsonb_build_object('products',result,'loadedAt',now());
end;
$$;

create function hub.list_support_intake_tenants(p_product_id uuid,p_offset integer default 0,p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; total bigint;
begin
  perform hub.authorize_app_admin();
  if p_offset is null or p_offset<0 or p_offset>100000 or p_limit is null or p_limit<1 or p_limit>50 then
    raise exception 'Invalid page.';
  end if;
  if not exists(select 1 from hub.products where id=p_product_id and slug in ('carebase','breathe','caremetric-emr','pennsync','caremetric-intel','caremetric-go')) then
    raise exception 'Unknown eligible product.';
  end if;
  select count(*) into total from hub.tenant_products where product_id=p_product_id;
  select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.name,row_data."tenantId"),'[]'::jsonb) into result from (
    select t.id as "tenantId",t.name,t.status as "tenantStatus",tp.status as "accessStatus",
      coalesce(setting.enabled,false) as enabled,setting.updated_at as "updatedAt",
      private.support_usable_member_count(t.id,p_product_id) as "usableMemberCount",
      private.is_case_intake_enabled(t.id,p_product_id) and private.support_usable_member_count(t.id,p_product_id)>0 as ready
    from hub.tenant_products tp join hub.tenants t on t.id=tp.tenant_id
    left join private.case_intake_settings setting on setting.tenant_id=t.id and setting.product_id=p_product_id
    where tp.product_id=p_product_id order by t.name,t.id offset p_offset limit p_limit
  ) row_data;
  return jsonb_build_object('rows',result,'total',total,'offset',p_offset,'limit',p_limit);
end;
$$;

create function hub.set_support_intake(p_tenant_id uuid,p_product_id uuid,p_enabled boolean,p_reviewed boolean,p_expected_updated_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; setting private.case_intake_settings%rowtype; active boolean; revision timestamptz;
begin
  actor:=hub.authorize_app_command();
  if p_enabled is null or p_reviewed is distinct from true then raise exception 'Review the existing customer access first.'; end if;
  -- Serialize absent settings as well as existing ones, without creating access.
  select tp.status='active' and t.status='active' and p.status<>'retired' and p.support_enabled into active
  from hub.tenant_products tp join hub.tenants t on t.id=tp.tenant_id join hub.products p on p.id=tp.product_id
  where tp.tenant_id=p_tenant_id and tp.product_id=p_product_id
    and p.slug in ('carebase','breathe','caremetric-emr','pennsync','caremetric-intel','caremetric-go')
  for update of tp,t,p;
  if not found then raise exception 'Existing customer access required.'; end if;
  select * into setting from private.case_intake_settings where tenant_id=p_tenant_id and product_id=p_product_id for update;
  if setting.updated_at is distinct from p_expected_updated_at then raise exception 'Customer access changed. Refresh and review again.'; end if;
  if p_enabled and (not active or private.support_usable_member_count(p_tenant_id,p_product_id)=0) then
    raise exception 'Active access and a verified SMS customer account are required.';
  end if;
  insert into private.case_intake_settings(tenant_id,product_id,enabled,activated_at,activated_by)
    values(p_tenant_id,p_product_id,p_enabled,case when p_enabled then now() end,case when p_enabled then (actor->>'user_id')::uuid end)
  on conflict(tenant_id,product_id) do update set enabled=excluded.enabled,
    activated_at=case when excluded.enabled then now() else private.case_intake_settings.activated_at end,
    activated_by=case when excluded.enabled then excluded.activated_by else private.case_intake_settings.activated_by end
  returning updated_at into revision;
  -- Reuse the same support-owner check that actually gates case creation.
  if p_enabled and not private.is_case_intake_enabled(p_tenant_id,p_product_id) then
    raise exception 'An active verified support owner is required.';
  end if;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,tenant_id,product_id,changed_columns,metadata)
    values((actor->>'user_id')::uuid,'support.intake.set','tenant_product',p_tenant_id,p_tenant_id,p_product_id,array['enabled'],
      jsonb_build_object('enabled',p_enabled,'previousEnabled',coalesce(setting.enabled,false),'reviewed',true));
  return jsonb_build_object('enabled',p_enabled,'updatedAt',revision);
end;
$$;
revoke all on function hub.get_support_readiness() from public,anon;
revoke all on function hub.list_support_intake_tenants(uuid,integer,integer) from public,anon;
revoke all on function hub.set_support_intake(uuid,uuid,boolean,boolean,timestamptz) from public,anon;
grant execute on function hub.get_support_readiness() to authenticated;
grant execute on function hub.list_support_intake_tenants(uuid,integer,integer) to authenticated;
grant execute on function hub.set_support_intake(uuid,uuid,boolean,boolean,timestamptz) to authenticated;

-- 20260911183517_governed_source_credential_keys.sql
-- Preserve the deployed validator and its ACL; tighten recognized credential
-- field spellings in authored JSON without rewriting source evidence.
create or replace function private.validate_governed_learning_source(p_payload text, p_revision text) returns jsonb
language plpgsql set search_path='' as $$
declare document jsonb;
begin
  if p_payload is null or octet_length(p_payload)>2000000 or p_revision is null
    or p_revision !~ '^[0-9a-f]{64}$'
    or encode(extensions.digest(p_payload,'sha256'),'hex')<>p_revision then
    raise exception 'Source revision checksum or size is invalid.' using errcode='22023';
  end if;
  begin document:=p_payload::jsonb;
  exception when invalid_text_representation then
    raise exception 'Source payload is not valid JSON.' using errcode='22023';
  end;
  if not extensions.jsonb_matches_schema(private.governed_learning_schema(),document) then
    raise exception 'Source snapshot does not match carebase.course.v1.' using errcode='22023';
  end if;
  if document::text ~* '([?&](token|access_token|signature|sig|key|policy|jwt|auth|h|hdnts|hdnea|key-pair-id|api_key|apikey|x-amz-[a-z-]+|x-goog-[a-z-]+)=|"(access_?token|refresh_?token|service_?role_?key|authorization|password|client_?secret|storage_?(path|bucket)|video_?url|playback_?(url|token)|signed_?url|api_?key|token|secret|secret_?key|signing_?secret)"[[:space:]]*:)' then
    raise exception 'Remove playback credentials from the source export before staging.' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(document->'blocks') b
    where ((b->>'type'='quiz') is distinct from (b->'quiz'<>'null'::jsonb))
      or ((b->'quiz'->>'revealsAnswersAfterAttempt')::boolean and b->'quiz'->>'kind'<>'knowledge_check')) then
    raise exception 'Source quiz configuration is invalid.' using errcode='22023';
  end if;
  if exists(
    with blocks as(select value b from jsonb_array_elements(document->'blocks')),
    questions as(select q from blocks cross join lateral jsonb_array_elements(coalesce(nullif(b->'quiz'->'questions','null'::jsonb),'[]'::jsonb)) q),
    ids as (
      select 'block' kind, lower(b->>'id') id from blocks
      union all select 'quiz',lower(b->'quiz'->>'id') from blocks where b->'quiz'<>'null'::jsonb
      union all select 'question',lower(q->>'id') from questions
      union all select 'answer',lower(a->>'id') from questions cross join lateral jsonb_array_elements(q->'options') a
      union all select 'credit',lower(c->>'id') from jsonb_array_elements(document->'credits') c
      union all select 'package',lower(p->>'id') from jsonb_array_elements(document->'packages') p
    ) select 1 from ids group by kind,id having count(*)>1
  ) then raise exception 'The source snapshot repeats a content identifier.' using errcode='22023'; end if;
  return document;
end;
$$;

-- 20260911184616_hub_intel_admin_audience.sql
-- Intel's verified live Base44 runtime consumes only its own one-use SMS audience.
-- Preserve Go and all governed content/learning/command capabilities.
alter table private.app_delegations drop constraint app_delegations_audience_check;
alter table private.app_delegations add constraint app_delegations_audience_check
  check(audience in ('carebase','breathe','caremetric-emr','pennsync','caremetric-go','intel',
    'carebase.command','carebase.learning','publication','media'));

-- 20260911190122_learning_draft_editing_intents.sql
-- Extend reviewed native intentions to draft edits and explicit human approval.
-- Existing source pinning, current session authority and immutable replay are preserved.
create function private.learning_authoring_actions() returns text[]
language sql immutable security invoker set search_path='' as $$
  select array['learning.cloneVersion','learning.publishVersion','learning.patchDraft','learning.reviewDraft']::text[];
$$;
revoke all on function private.learning_authoring_actions() from public,anon,authenticated,hub_app_server;

create or replace function hub.remember_learning_authoring_preview(p_snapshot_id uuid,p_preview jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; source private.learning_source_snapshots%rowtype; prior private.learning_authoring_intents%rowtype;
  v_command_id uuid; expires timestamptz; head_id uuid;
begin
  actor:=hub.authorize_app_command();
  perform private.require_learning_editor();
  if p_preview is null or jsonb_typeof(p_preview)<>'object' or octet_length(p_preview::text)>32000
    or not(p_preview ?& array['commandId','courseId','action','reason','previewDigest','expiresAt','before','after'])
    or p_preview-array['commandId','courseId','action','reason','previewDigest','expiresAt','before','after']<>'{}'::jsonb
    or not(coalesce(p_preview->>'action','')=any(private.learning_authoring_actions()))
    or coalesce(p_preview->>'previewDigest','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_preview->'before')<>'object' or jsonb_typeof(p_preview->'after')<>'object'
    or coalesce(length(p_preview->>'reason'),0) not between 10 and 500 then
    raise exception 'Invalid course preview.' using errcode='22023';
  end if;
  begin v_command_id:=(p_preview->>'commandId')::uuid; expires:=(p_preview->>'expiresAt')::timestamptz;
  exception when others then raise exception 'Invalid course preview identity.' using errcode='22023'; end;
  if v_command_id is null or expires is null or not isfinite(expires) or expires>clock_timestamp()+interval '5 minutes 5 seconds' then
    raise exception 'Invalid course preview lifetime.' using errcode='22023';
  end if;
  select * into source from private.learning_source_snapshots where id=p_snapshot_id;
  if not found or (p_preview->>'courseId')::uuid is distinct from source.source_course_id
    or (p_preview->'before'->>'courseId')::uuid is distinct from source.source_course_id
    or (p_preview->'before'->>'versionId')::uuid is distinct from source.source_version_id
    or p_preview->'before'->>'sourceRevision' is distinct from source.source_revision then
    raise exception 'The preview does not match the reviewed source.' using errcode='40001';
  end if;
  -- Serialize against source staging. A first preview must pin the current head.
  perform 1 from hub.content_items where id=source.item_id for update;
  select id into head_id from private.learning_source_snapshots where source_course_id=source.source_course_id order by sequence desc limit 1;
  select * into prior from private.learning_authoring_intents where learning_authoring_intents.command_id=v_command_id;
  if found then
    if prior.actor_id is distinct from (actor->>'user_id')::uuid or prior.session_id is distinct from (actor->>'session_id')::uuid
      or prior.snapshot_id is distinct from p_snapshot_id or prior.preview is distinct from p_preview then
      raise exception 'This command belongs to a different preview.' using errcode='40001';
    end if;
    return prior.preview;
  end if;
  if head_id is distinct from p_snapshot_id or expires<=clock_timestamp() then
    raise exception 'The preview or reviewed source changed. Refresh it.' using errcode='40001';
  end if;
  insert into private.learning_authoring_intents(command_id,actor_id,session_id,snapshot_id,preview_digest,preview,expires_at)
    values(v_command_id,(actor->>'user_id')::uuid,(actor->>'session_id')::uuid,p_snapshot_id,p_preview->>'previewDigest',p_preview,expires);
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values((actor->>'user_id')::uuid,'learning.authoring.preview','content_item',source.item_id,
      jsonb_build_object('command_id',v_command_id,'snapshot_id',source.id,'source_revision',source.source_revision));
  return p_preview;
end;
$$;

create or replace function hub.get_learning_authoring_intent(p_command_id uuid,p_expected_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; intent private.learning_authoring_intents%rowtype;
begin
  actor:=hub.authorize_app_command();
  perform private.require_learning_editor();
  select * into intent from private.learning_authoring_intents where command_id=p_command_id;
  if not found or intent.actor_id is distinct from (actor->>'user_id')::uuid or intent.session_id is distinct from (actor->>'session_id')::uuid then
    raise exception 'This course preview is unavailable.' using errcode='42501';
  end if;
  if p_expected_digest is distinct from intent.preview_digest then
    raise exception 'The course preview changed.' using errcode='40001';
  end if;
  -- Immutable source snapshots cannot be overwritten. Native CAS checks the
  -- current source before the first write; native replay checks current authority.
  return jsonb_build_object('preview',intent.preview,'result',intent.result);
end;
$$;

create or replace function hub.record_learning_authoring_result(p_command_id uuid,p_expected_digest text,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.learning_authoring_intents%rowtype; actor jsonb; source_item uuid;
begin
  actor:=hub.authorize_app_command();
  perform hub.get_learning_authoring_intent(p_command_id,p_expected_digest);
  select * into intent from private.learning_authoring_intents where command_id=p_command_id for update;
  if p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>8000
    or not(p_result ?& array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed'])
    or p_result-array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed','sourceRevision']<>'{}'::jsonb
    or ((p_result->>'action' in ('learning.patchDraft','learning.reviewDraft')) is distinct from (p_result ? 'sourceRevision'))
    or (p_result ? 'sourceRevision' and coalesce(p_result->>'sourceRevision','') !~ '^[0-9a-f]{64}$')
    or p_result->>'commandId' is distinct from intent.preview->>'commandId'
    or p_result->>'courseId' is distinct from intent.preview->>'courseId'
    or p_result->>'action' is distinct from intent.preview->>'action'
    or p_result->>'status' is distinct from intent.preview->'after'->>'status'
    or p_result->'versionNumber' is distinct from intent.preview->'after'->'versionNumber'
    or coalesce(p_result->>'versionId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or jsonb_typeof(p_result->'replayed') is distinct from 'boolean'
    or (p_result->>'action'<>'learning.cloneVersion' and p_result->>'versionId' is distinct from intent.preview->'before'->>'versionId')
    or (p_result->>'action'='learning.cloneVersion' and p_result->>'versionId' is not distinct from intent.preview->'before'->>'versionId') then
    raise exception 'The native outcome does not match the preview.' using errcode='22023';
  end if;
  if intent.result is not null then
    if intent.result-'replayed' is distinct from p_result-'replayed' then
      raise exception 'The native result changed.' using errcode='40001';
    end if;
    return intent.result||jsonb_build_object('replayed',true);
  end if;
  update private.learning_authoring_intents set result=p_result,completed_at=now() where command_id=p_command_id;
  select item_id into source_item from private.learning_source_snapshots where id=intent.snapshot_id;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values((actor->>'user_id')::uuid,'learning.authoring.applied','content_item',source_item,
      jsonb_build_object('command_id',p_command_id,'action',p_result->>'action','version_id',p_result->>'versionId'));
  return p_result;
end;
$$;
revoke all on function hub.remember_learning_authoring_preview(uuid,jsonb),hub.get_learning_authoring_intent(uuid,text),hub.record_learning_authoring_result(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function hub.remember_learning_authoring_preview(uuid,jsonb),hub.get_learning_authoring_intent(uuid,text),hub.record_learning_authoring_result(uuid,text,jsonb) to authenticated;

-- 20260911190819_combined_authoring_publication_support_contract.sql
-- Declare only reviewed, additive capabilities after their SQL boundaries exist.
-- This metadata grants no actor authority and does not attest native deployment.
do $$
declare signature text; relation_name text;
begin
  if to_regprocedure('hub.get_backend_contract()') is null then
    raise exception 'Apply the reviewed API 4 foundation first' using errcode='55000';
  end if;
  if (hub.get_backend_contract() @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1"]}'::jsonb) is not true then
    raise exception 'Apply the reviewed API 4 foundation and receipt features first' using errcode='55000';
  end if;
  foreach signature in array array[
    'hub.authorize_app_admin()',
    'hub.authorize_app_command()',
    'private.current_app_session_verified()',
    'hub.get_learning_editor_access()',
    'hub.remember_learning_authoring_preview(uuid,jsonb)',
    'hub.get_learning_authoring_intent(uuid,text)',
    'hub.record_learning_authoring_result(uuid,text,jsonb)',
    'private.publication_import_access()',
    'private.stage_publication_import(uuid,jsonb)',
    'private.get_publication_import(uuid)',
    'private.get_publication_import_context(uuid)',
    'private.verify_publication_asset(uuid,text,text,integer,text)',
    'private.store_publication_preview(uuid,jsonb)',
    'private.commit_publication_import(uuid,jsonb)',
    'private.publication_object(uuid,text,text)',
    'private.publication_media_info(uuid)',
    'private.publication_public_object(uuid,text)',
    'private.publication_public_media_info(uuid)',
    'private.issue_publication_public_download(text,uuid,text,text)',
    'private.consume_publication_public_download(text)',
    'private.issue_publication_cleanup(text)',
    'private.consume_publication_cleanup(text)',
    'private.finish_publication_cleanup(uuid)',
    'private.support_usable_member_count(uuid,uuid)',
    'hub.get_support_readiness()',
    'hub.list_support_intake_tenants(uuid,integer,integer)',
    'hub.set_support_intake(uuid,uuid,boolean,boolean,timestamp with time zone)'
  ] loop
    if to_regprocedure(signature) is null then
      raise exception 'Apply reviewed feature migrations first; missing function %',signature using errcode='55000';
    end if;
  end loop;
  foreach relation_name in array array[
    'private.learning_authoring_intents',
    'private.publication_import_settings',
    'private.publication_imports',
    'private.publication_import_assets',
    'private.publication_revision_provenance',
    'private.publication_public_downloads',
    'private.publication_cleanup_tokens',
    'private.case_intake_settings',
    'private.app_delegations'
  ] loop
    if to_regclass(relation_name) is null then
      raise exception 'Apply reviewed feature migrations first; missing table %',relation_name using errcode='55000';
    end if;
  end loop;
  -- Intel uses the existing live administrator procedure and its own closed
  -- delegation audience. No browser/native role is inferred from this feature.
  if not exists(select 1 from pg_catalog.pg_constraint c
    where c.conrelid='private.app_delegations'::regclass
      and c.conname='app_delegations_audience_check' and c.contype='c' and c.convalidated
      and position('''intel''::text' in pg_catalog.pg_get_expr(c.conbin,c.conrelid))>0) then
    raise exception 'Apply the reviewed Intel delegation audience first' using errcode='55000';
  end if;
end;
$$;

create or replace function hub.get_backend_contract() returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('api_version',4,'features',jsonb_build_array(
    'learning.runtime.v1','platform.admin.read.v1','app.sms.v1','learning.sources.v1',
    'platform.admin.command.v1','learning.receipts.v1','learning.authoring.v1',
    'knowledge.publications.v1','support.readiness.v1','platform.admin.intel.v1'));
$$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- 20260911192238_learning_draft_editing_contract.sql
-- The editing interface must not start against clone/publication-only intent SQL.
do $$
begin
  if to_regprocedure('private.learning_authoring_actions()') is null
    or to_regprocedure('hub.remember_learning_authoring_preview(uuid,jsonb)') is null
    or to_regprocedure('hub.record_learning_authoring_result(uuid,text,jsonb)') is null then
    raise exception 'Apply the reviewed draft editing intent migration first' using errcode='55000';
  end if;
  if (private.learning_authoring_actions() @> array['learning.patchDraft','learning.reviewDraft']::text[]) is not true
    or (hub.get_backend_contract() @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1"]}'::jsonb) is not true then
    raise exception 'Apply the reviewed draft editing and combined platform contract first' using errcode='55000';
  end if;
end;
$$;
create or replace function hub.get_backend_contract() returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('api_version',4,'features',jsonb_build_array(
    'learning.runtime.v1','platform.admin.read.v1','app.sms.v1','learning.sources.v1',
    'platform.admin.command.v1','learning.receipts.v1','learning.authoring.v1',
    'knowledge.publications.v1','support.readiness.v1','platform.admin.intel.v1','learning.draft-editing.v1'));
$$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- 20260911192604_billing_portal_intents.sql
-- Hub preserves review ownership only. CareBase owns the Stripe reservation,
-- idempotency key and session URL. Provider URLs never enter this database.
create type private.billing_portal_action as enum ('billing.portal.create');
create table private.billing_portal_intents (
  request_id uuid primary key,
  actor_id uuid not null references hub.profiles(id),
  session_id uuid not null references private.sms_sessions(id),
  organization_id uuid not null,
  action private.billing_portal_action not null default 'billing.portal.create',
  request jsonb not null check(octet_length(request::text)<=4096),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  preview_dispatched_at timestamptz,
  command_id uuid unique,
  preview jsonb check(octet_length(preview::text)<=8192),
  preview_expires_at timestamptz,
  dispatched_at timestamptz,
  result jsonb check(octet_length(result::text)<=4096),
  retry_at timestamptz,
  discarded_at timestamptz,
  check((preview is null)=(command_id is null)),
  check((preview is null)=(preview_expires_at is null)),
  check(result is null or dispatched_at is not null),
  check(discarded_at is null or preview_dispatched_at is null)
);
create index billing_portal_intents_actor_idx on private.billing_portal_intents(actor_id,created_at);
create index billing_portal_intents_session_idx on private.billing_portal_intents(session_id,organization_id,created_at);
create index billing_portal_intents_created_idx on private.billing_portal_intents(created_at);
create index billing_portal_intents_expiry_idx on private.billing_portal_intents(expires_at);
alter table private.billing_portal_intents enable row level security;
revoke all on private.billing_portal_intents from public,anon,authenticated,service_role,hub_app_server;

create function private.billing_portal_actor() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if session_user<>'hub_app_server' then raise exception 'Application server required.' using errcode='42501'; end if;
  return hub.authorize_app_command();
end;
$$;
create function private.billing_portal_intent_view(p_intent private.billing_portal_intents) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('request',p_intent.request,'preview',p_intent.preview,'result',p_intent.result,
    'createdAt',p_intent.created_at,'expiresAt',p_intent.expires_at,'previewDispatchedAt',p_intent.preview_dispatched_at,
    'dispatchedAt',p_intent.dispatched_at,'retryAt',p_intent.retry_at);
$$;
create function private.require_billing_portal_intent(p_request_id uuid) returns private.billing_portal_intents
language plpgsql security definer set search_path='' as $$
declare actor jsonb; intent private.billing_portal_intents%rowtype;
begin
  actor:=private.billing_portal_actor();
  select * into intent from private.billing_portal_intents where request_id=p_request_id for update;
  if not found or intent.actor_id is distinct from (actor->>'user_id')::uuid
    or intent.session_id is distinct from (actor->>'session_id')::uuid or intent.expires_at<=now() or intent.discarded_at is not null then
    raise exception 'This billing review is unavailable.' using errcode='42501';
  end if;
  return intent;
end;
$$;
create function private.resume_billing_portal(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; intent private.billing_portal_intents%rowtype;
begin
  actor:=private.billing_portal_actor();
  select * into intent from private.billing_portal_intents where organization_id=p_organization_id
    and actor_id=(actor->>'user_id')::uuid and session_id=(actor->>'session_id')::uuid
    and expires_at>now() and discarded_at is null order by created_at desc,request_id desc limit 1;
  if not found then return null; end if;
  return private.billing_portal_intent_view(intent);
end;
$$;
create function private.reserve_billing_portal(p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; intent private.billing_portal_intents%rowtype; v_request_id uuid; v_organization_id uuid;
begin
  actor:=private.billing_portal_actor();
  if p_request is null or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>4096
    or not(p_request ?& array['operation','requestId','action','targetId','parameters','reason'])
    or p_request-array['operation','requestId','action','targetId','parameters','reason']<>'{}'::jsonb
    or p_request->>'operation' is distinct from 'preview' or p_request->>'action' is distinct from 'billing.portal.create'
    or p_request->'parameters' is distinct from '{}'::jsonb or jsonb_typeof(p_request->'reason') is distinct from 'string'
    or coalesce(length(p_request->>'reason'),0) not between 10 and 500 or p_request->>'reason'<>btrim(p_request->>'reason')
    or p_request->>'reason' ~ '[[:cntrl:]]' then
    raise exception 'Invalid billing review.' using errcode='22023';
  end if;
  begin v_request_id:=(p_request->>'requestId')::uuid; v_organization_id:=(p_request->>'targetId')::uuid;
  exception when others then raise exception 'Invalid billing identity.' using errcode='22023'; end;
  if v_request_id is null or v_organization_id is null then raise exception 'Invalid billing identity.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing.portal.reserve',0));
  -- Private request metadata expires; native financial/session audit remains native.
  delete from private.billing_portal_intents where expires_at<now()-interval '30 days';
  select * into intent from private.billing_portal_intents i where i.request_id=v_request_id;
  if found then
    intent:=private.require_billing_portal_intent(v_request_id);
    if intent.request is distinct from p_request then raise exception 'This request key has a different review.' using errcode='40001'; end if;
    return private.billing_portal_intent_view(intent);
  end if;
  if exists(select 1 from private.billing_portal_intents i where i.organization_id=v_organization_id
    and actor_id=(actor->>'user_id')::uuid and session_id=(actor->>'session_id')::uuid and expires_at>now() and discarded_at is null
    and (result is null or result->>'outcome'='pending')
    and (dispatched_at is not null or preview_expires_at>now() or (preview is null and created_at>now()-interval '6 minutes'))) then
    raise exception 'Resume the existing billing review before starting another.' using errcode='40001';
  end if;
  if (select count(*) from private.billing_portal_intents where created_at>now()-interval '1 hour')>=200
    or (select count(*) from private.billing_portal_intents where actor_id=(actor->>'user_id')::uuid and created_at>now()-interval '1 hour')>=20 then
    raise exception 'Billing review limit reached.' using errcode='54000';
  end if;
  insert into private.billing_portal_intents(request_id,actor_id,session_id,organization_id,request,expires_at)
    values(v_request_id,(actor->>'user_id')::uuid,(actor->>'session_id')::uuid,v_organization_id,p_request,(actor->>'assurance_expires_at')::timestamptz)
    returning * into intent;
  return private.billing_portal_intent_view(intent);
end;
$$;
create function private.dispatch_billing_portal_preview(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.billing_portal_intents%rowtype;
begin
  intent:=private.require_billing_portal_intent(p_request_id);
  update private.billing_portal_intents set preview_dispatched_at=coalesce(preview_dispatched_at,now()) where request_id=p_request_id returning * into intent;
  return private.billing_portal_intent_view(intent);
end;
$$;
create function private.remember_billing_portal_preview(p_request_id uuid,p_preview jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.billing_portal_intents%rowtype; v_command_id uuid; expires timestamptz;
begin
  intent:=private.require_billing_portal_intent(p_request_id);
  if intent.preview_dispatched_at is null or p_preview is null or jsonb_typeof(p_preview)<>'object'
    or octet_length(p_preview::text)>8192 or not(p_preview ?& array['commandId','action','targetId','reason','expiresAt','previewDigest','summary'])
    or p_preview-array['commandId','action','targetId','reason','expiresAt','previewDigest','summary']<>'{}'::jsonb
    or p_preview->>'action' is distinct from 'billing.portal.create' or p_preview->>'targetId' is distinct from intent.request->>'targetId'
    or p_preview->>'reason' is distinct from intent.request->>'reason' or coalesce(p_preview->>'previewDigest','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_preview->'summary') is distinct from 'object'
    or not(p_preview->'summary' ?& array['kind','organizationName','providerCustomerId','providerConfigurationId','returnPath'])
    or (p_preview->'summary')-array['kind','organizationName','providerCustomerId','providerConfigurationId','returnPath']<>'{}'::jsonb
    or p_preview->'summary'->>'kind' is distinct from 'portal' or p_preview->'summary'->>'returnPath' is distinct from '/admin/enterprise'
    or coalesce(p_preview->'summary'->>'providerCustomerId','') !~ '^cus_[A-Za-z0-9]+$'
    or coalesce(p_preview->'summary'->>'providerConfigurationId','') !~ '^bpc_[A-Za-z0-9]+$'
    or jsonb_typeof(p_preview->'summary'->'organizationName') is distinct from 'string'
    or length(p_preview->'summary'->>'organizationName')>500 then
    raise exception 'Invalid native billing preview.' using errcode='22023';
  end if;
  begin v_command_id:=(p_preview->>'commandId')::uuid; expires:=(p_preview->>'expiresAt')::timestamptz;
  exception when others then raise exception 'Invalid billing preview identity.' using errcode='22023'; end;
  if v_command_id is null or expires is null or not isfinite(expires) or expires>clock_timestamp()+interval '5 minutes 1 second' then
    raise exception 'Invalid billing preview lifetime.' using errcode='22023';
  end if;
  if intent.preview is not null then
    if intent.preview is distinct from p_preview then raise exception 'The billing preview changed.' using errcode='40001'; end if;
    return private.billing_portal_intent_view(intent);
  end if;
  if expires<=clock_timestamp() then raise exception 'The billing preview expired.' using errcode='40001'; end if;
  update private.billing_portal_intents set command_id=v_command_id,preview=p_preview,preview_expires_at=expires
    where request_id=p_request_id returning * into intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(intent.actor_id,'billing.portal.preview','native_organization',intent.organization_id,jsonb_build_object('command_id',v_command_id));
  return private.billing_portal_intent_view(intent);
end;
$$;
create function private.claim_billing_portal(p_command_id uuid,p_expected_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.billing_portal_intents%rowtype; request_id uuid;
begin
  perform private.billing_portal_actor();
  select i.request_id into request_id from private.billing_portal_intents i where i.command_id=p_command_id;
  intent:=private.require_billing_portal_intent(request_id);
  if p_expected_digest is distinct from intent.preview->>'previewDigest' then raise exception 'Billing review changed.' using errcode='40001'; end if;
  if intent.dispatched_at is null and intent.preview_expires_at<=clock_timestamp() then raise exception 'Billing review expired.' using errcode='40001'; end if;
  update private.billing_portal_intents set dispatched_at=coalesce(dispatched_at,now()) where billing_portal_intents.request_id=intent.request_id returning * into intent;
  return private.billing_portal_intent_view(intent);
end;
$$;
create function private.record_billing_portal_result(p_command_id uuid,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.billing_portal_intents%rowtype; request_id uuid; outcome text;
begin
  perform private.billing_portal_actor();
  select i.request_id into request_id from private.billing_portal_intents i where i.command_id=p_command_id;
  intent:=private.require_billing_portal_intent(request_id);
  outcome:=p_result->>'outcome';
  if intent.dispatched_at is null or p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>4096
    or not(p_result ?& array['commandId','action','targetId','outcome','replayed','completedAt','retryAfterSeconds','session'])
    or p_result-array['commandId','action','targetId','outcome','replayed','completedAt','retryAfterSeconds','session']<>'{}'::jsonb
    or p_result->>'commandId' is distinct from p_command_id::text or p_result->>'targetId' is distinct from intent.organization_id::text
    or p_result->>'action' is distinct from 'billing.portal.create' or coalesce(outcome,'') not in ('created','pending','failed')
    or jsonb_typeof(p_result->'replayed') is distinct from 'boolean'
    or (outcome='pending' and (p_result->'completedAt' is distinct from 'null'::jsonb or p_result->'retryAfterSeconds' is distinct from '30'::jsonb))
    or (outcome<>'pending' and (jsonb_typeof(p_result->'completedAt') is distinct from 'string' or p_result->'retryAfterSeconds' is distinct from 'null'::jsonb))
    or (outcome<>'created' and p_result->'session' is distinct from 'null'::jsonb)
    or (outcome='created' and (jsonb_typeof(p_result->'session') is distinct from 'object'
      or not(p_result->'session' ?& array['kind','id','expiresAt','livemode'])
      or (p_result->'session')-array['kind','id','expiresAt','livemode']<>'{}'::jsonb
      or p_result->'session'->>'kind' is distinct from 'portal' or coalesce(p_result->'session'->>'id','') !~ '^bps_[A-Za-z0-9]+$'
      or p_result->'session'->'expiresAt' is distinct from 'null'::jsonb or jsonb_typeof(p_result->'session'->'livemode') is distinct from 'boolean')) then
    raise exception 'Invalid redacted billing result.' using errcode='22023';
  end if;
  if intent.result is not null and intent.result->>'outcome'<>'pending' then
    -- A slower concurrent pending observation cannot regress a terminal receipt.
    if outcome='pending' then return private.billing_portal_intent_view(intent); end if;
    if intent.result-'replayed' is distinct from p_result-'replayed' then raise exception 'The native billing outcome changed.' using errcode='40001'; end if;
    return private.billing_portal_intent_view(intent);
  end if;
  update private.billing_portal_intents set result=p_result,retry_at=case when outcome='pending' then now()+interval '30 seconds' end
    where billing_portal_intents.request_id=intent.request_id returning * into intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(intent.actor_id,'billing.portal.result','native_organization',intent.organization_id,jsonb_build_object('command_id',p_command_id,'outcome',outcome));
  return private.billing_portal_intent_view(intent);
end;
$$;
create function private.discard_billing_portal(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.billing_portal_intents%rowtype;
begin
  intent:=private.require_billing_portal_intent(p_request_id);
  if intent.preview_dispatched_at is not null or intent.dispatched_at is not null then raise exception 'A dispatched review must retain its request identity.' using errcode='40001'; end if;
  update private.billing_portal_intents set discarded_at=now() where request_id=p_request_id;
  return jsonb_build_object('discarded',true);
end;
$$;

revoke all on function private.billing_portal_actor(),private.billing_portal_intent_view(private.billing_portal_intents),private.require_billing_portal_intent(uuid),
  private.resume_billing_portal(uuid),private.reserve_billing_portal(jsonb),private.dispatch_billing_portal_preview(uuid),private.remember_billing_portal_preview(uuid,jsonb),
  private.claim_billing_portal(uuid,text),private.record_billing_portal_result(uuid,jsonb),private.discard_billing_portal(uuid) from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.resume_billing_portal(uuid),private.reserve_billing_portal(jsonb),private.dispatch_billing_portal_preview(uuid),private.remember_billing_portal_preview(uuid,jsonb),
  private.claim_billing_portal(uuid,text),private.record_billing_portal_result(uuid,jsonb),private.discard_billing_portal(uuid) to hub_app_server;

-- 20260911193000_support_customer_onboarding.sql
-- Operator-reviewed native account proof. This migration provisions no users,
-- memberships, mappings or case intake. The HTTP coordinator alone supplies
-- freshly resolved native facts; browsers cannot call these SQL functions.
alter table private.federation_issuers add column verification_method text not null default 'oidc';
alter table private.federation_issuers alter column jwks_url drop not null;
alter table private.federation_issuers add constraint federation_verification_method_check check
  ((verification_method='oidc' and jwks_url is not null) or
   (verification_method='operator_review' and jwks_url is null and not enabled));

create table private.support_onboarding_intents (
  id uuid primary key default gen_random_uuid(), actor_id uuid not null references auth.users(id),
  session_id uuid not null references private.sms_sessions(id), product_id uuid not null references hub.products(id),
  identity jsonb not null, hub_user_id uuid not null references auth.users(id), hub_tenant_id uuid not null,
  tenant_name text not null, hub_display_name text not null, state_digest text not null, proof_digest text not null,
  created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '60 seconds',
  applied_at timestamptz, request_id uuid unique, result jsonb,
  check ((applied_at is null and request_id is null and result is null) or (applied_at is not null and request_id is not null and result is not null))
);
create index support_onboarding_session_idx on private.support_onboarding_intents(session_id,created_at);
alter table private.support_onboarding_intents enable row level security;
revoke all on private.support_onboarding_intents from public,anon,authenticated,service_role,hub_app_server;

create function private.require_support_onboarding_actor(p_actor_id uuid,p_session_id uuid) returns void
language plpgsql stable security definer set search_path='' as $$
declare actor jsonb;
begin
  actor:=hub.authorize_app_command();
  if actor->>'method'<>'sms' or actor->>'user_id' is distinct from p_actor_id::text
    or actor->>'session_id' is distinct from p_session_id::text then
    raise exception 'Current administrator SMS session required.' using errcode='28000'; end if;
end; $$;

create function private.support_identity_hash(p_value text) returns text
language sql immutable strict set search_path='' as $$ select encode(extensions.digest(p_value,'sha256'),'hex'); $$;

create function private.validate_support_identity(p_identity jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare product text:=p_identity->>'product'; uid text:=p_identity->>'sourceUserId'; aid text:=p_identity->>'sourceAccountId';
  kind text; relation text; pattern text;
begin
  if p_identity is null or jsonb_typeof(p_identity)<>'object' or
    (select array_agg(key order by key) from jsonb_object_keys(p_identity) key)
      is distinct from array['accountKind','product','relationship','revision','sourceAccountId','sourceUserId']::text[]
    or product not in ('breathe','caremetric-emr','caremetric-go','pennsync','intel') or product is null
    or p_identity->>'revision' is null or (p_identity->>'revision') !~ '^[0-9a-f]{64}$' then
    raise exception 'Verified native identity required.' using errcode='22023'; end if;
  kind:=case product when 'intel' then 'individual' when 'pennsync' then 'agency' else 'organization' end;
  relation:=case product when 'intel' then 'individual_owner' when 'pennsync' then 'agency_member' else 'organization_member' end;
  pattern:=case when product in ('intel','pennsync') then '^[0-9a-f]{24}$' else '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' end;
  if p_identity->>'accountKind' is distinct from kind or p_identity->>'relationship' is distinct from relation
    or aid is null or aid !~ pattern or uid is null
    or (product='breathe' and uid !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')
    or (product<>'breathe' and uid !~ pattern) or (product='intel' and uid<>aid) then
    raise exception 'Verified native account relationship required.' using errcode='22023'; end if;
  return product;
end; $$;

create function private.support_onboarding_user(p_user uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare display_name text;
begin
  select p.display_name into display_name from auth.users u join hub.profiles p on p.id=u.id
    join private.sms_identities i on i.user_id=u.id where u.id=p_user and u.deleted_at is null
    and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=now())
    and i.revoked_at is null and i.verified_at is not null;
  if display_name is null then raise exception 'Existing verified Hub SMS user required.' using errcode='42501'; end if;
  return display_name;
end; $$;

-- Snapshot all access rows that a reviewed pairing could otherwise overwrite.
create function private.support_onboarding_state(p_identity jsonb,p_hub_user uuid,p_hub_tenant uuid) returns text
language sql stable security definer set search_path='' as $$
  select private.support_identity_hash(jsonb_build_object(
    'hubIdentity',(select jsonb_build_object('version',i.identity_version,'verifiedAt',i.verified_at,'revokedAt',i.revoked_at) from private.sms_identities i where i.user_id=p_hub_user),
    'hubProfile',(select to_jsonb(p) from hub.profiles p where p.id=p_hub_user),
    'issuer',(select to_jsonb(f) from private.federation_issuers f where f.issuer='urn:caremetric:support:'||(p_identity->>'product')),
    'principal',(select to_jsonb(p) from private.federated_principals p join private.federation_issuers f on f.id=p.issuer_id
      where f.issuer='urn:caremetric:support:'||(p_identity->>'product') and p.external_subject_hash=private.support_identity_hash(p_identity->>'sourceUserId')),
    'binding',(select to_jsonb(t) from private.federated_tenants t join private.federation_issuers f on f.id=t.issuer_id
      where f.issuer='urn:caremetric:support:'||(p_identity->>'product') and t.external_tenant_hash=private.support_identity_hash(p_identity->>'sourceAccountId')),
    'tenant',(select to_jsonb(t) from hub.tenants t where t.id=p_hub_tenant),
    'product',(select to_jsonb(p) from hub.products p where p.slug=case p_identity->>'product' when 'intel' then 'caremetric-intel' else p_identity->>'product' end),
    'access',(select to_jsonb(t) from hub.tenant_products t join hub.products p on p.id=t.product_id where t.tenant_id=p_hub_tenant and p.slug=case p_identity->>'product' when 'intel' then 'caremetric-intel' else p_identity->>'product' end),
    'member',(select to_jsonb(m) from hub.tenant_product_memberships m join hub.products p on p.id=m.product_id where m.tenant_id=p_hub_tenant and m.user_id=p_hub_user and p.slug=case p_identity->>'product' when 'intel' then 'caremetric-intel' else p_identity->>'product' end),
    'intake',(select to_jsonb(s) from private.case_intake_settings s join hub.products p on p.id=s.product_id where s.tenant_id=p_hub_tenant and p.slug=case p_identity->>'product' when 'intel' then 'caremetric-intel' else p_identity->>'product' end)
  )::text);
$$;

create function private.support_onboarding_view(p_intent private.support_onboarding_intents) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('intentId',p_intent.id,'proofDigest',p_intent.proof_digest,'expiresAt',p_intent.expires_at,
    'identity',p_intent.identity,'hubUserId',p_intent.hub_user_id,'hubDisplayName',p_intent.hub_display_name,
    'hubTenantId',p_intent.hub_tenant_id,'tenantName',p_intent.tenant_name,'access','customer','caseScope','own','intakeEnabled',false);
$$;

create function hub.prepare_support_onboarding(p_actor_id uuid,p_session_id uuid,p_identity jsonb,p_hub_user_id uuid,p_tenant_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare product text; pid uuid; tenant uuid; display_name text; intent private.support_onboarding_intents%rowtype;
begin
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  product:=private.validate_support_identity(p_identity);
  display_name:=private.support_onboarding_user(p_hub_user_id);
  if p_tenant_name is null or char_length(btrim(p_tenant_name)) not between 2 and 180 then
    raise exception 'Review the customer account name.' using errcode='22023'; end if;
  select id into pid from hub.products where slug=case product when 'intel' then 'caremetric-intel' else product end and status<>'retired' and support_enabled;
  if pid is null then raise exception 'Eligible support product required.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('support-preview:'||p_session_id::text,0));
  if (select count(*) from private.support_onboarding_intents where session_id=p_session_id and created_at>now()-interval '15 minutes')>=30 then
    raise exception 'Too many account previews. Try later.' using errcode='42501'; end if;
  select t.hub_tenant_id into tenant from private.federated_tenants t join private.federation_issuers f on f.id=t.issuer_id
    where f.issuer='urn:caremetric:support:'||product and t.external_tenant_hash=private.support_identity_hash(p_identity->>'sourceAccountId');
  tenant:=coalesce(tenant,gen_random_uuid());
  if exists(select 1 from private.case_intake_settings where tenant_id=tenant and product_id=pid and enabled) then
    raise exception 'Disable and review existing intake before linking another customer.' using errcode='42501'; end if;
  -- Display the canonical name for an existing account; never rename it implicitly.
  select coalesce((select name from hub.tenants where id=tenant),btrim(p_tenant_name)) into p_tenant_name;
  insert into private.support_onboarding_intents(actor_id,session_id,product_id,identity,hub_user_id,hub_tenant_id,tenant_name,hub_display_name,state_digest,proof_digest)
    values(p_actor_id,p_session_id,pid,p_identity,p_hub_user_id,tenant,p_tenant_name,display_name,
      private.support_onboarding_state(p_identity,p_hub_user_id,tenant),private.support_identity_hash(gen_random_uuid()::text)) returning * into intent;
  return private.support_onboarding_view(intent);
end; $$;

create function hub.inspect_support_onboarding(p_actor_id uuid,p_session_id uuid,p_intent_id uuid,p_proof_digest text,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.support_onboarding_intents%rowtype;
begin
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  select * into intent from private.support_onboarding_intents where id=p_intent_id and actor_id=p_actor_id and session_id=p_session_id;
  if not found or p_request_id is null or intent.proof_digest is distinct from p_proof_digest
    or (intent.applied_at is null and intent.expires_at<=now()) or (intent.applied_at is not null and intent.request_id<>p_request_id) then
    raise exception 'Preview changed or expired.' using errcode='40001'; end if;
  perform private.support_onboarding_user(intent.hub_user_id);
  return private.support_onboarding_view(intent);
end; $$;

create function hub.apply_support_onboarding(p_actor_id uuid,p_session_id uuid,p_intent_id uuid,p_proof_digest text,p_request_id uuid,p_identity jsonb,p_reviewed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.support_onboarding_intents%rowtype; product text; fid uuid; principal private.federated_principals%rowtype;
  prior_tenant uuid; member hub.tenant_product_memberships%rowtype; v_result jsonb;
begin
  perform hub.inspect_support_onboarding(p_actor_id,p_session_id,p_intent_id,p_proof_digest,p_request_id);
  if p_reviewed is distinct from true then raise exception 'Review the exact account pairing.' using errcode='22023'; end if;
  product:=private.validate_support_identity(p_identity);
  select * into intent from private.support_onboarding_intents where id=p_intent_id for update;
  if intent.identity is distinct from p_identity then raise exception 'Native account relationship changed.' using errcode='40001'; end if;
  -- Serialize both mappings, including concurrent previews by different admins.
  perform pg_advisory_xact_lock(hashtextextended('support-issuer:'||product,0));
  perform pg_advisory_xact_lock(hashtextextended('support-request:'||p_request_id::text,0));
  if exists(select 1 from private.support_onboarding_intents where request_id=p_request_id and id<>p_intent_id)
    or (intent.request_id is not null and intent.request_id<>p_request_id)
    or (intent.applied_at is null and intent.expires_at<=now()) then raise exception 'Preview changed or expired.' using errcode='40001'; end if;
  -- Lock existing mutable rows as well as serializing this provisioning path.
  perform 1 from auth.users where id=intent.hub_user_id for share;
  perform 1 from hub.profiles where id=intent.hub_user_id for share;
  perform 1 from private.sms_identities where user_id=intent.hub_user_id for share;
  perform 1 from hub.products where id=intent.product_id and status<>'retired' and support_enabled for update;
  if not found then raise exception 'Eligible support product required.' using errcode='42501'; end if;
  perform 1 from hub.tenants where id=intent.hub_tenant_id for update;
  perform 1 from hub.tenant_products where tenant_id=intent.hub_tenant_id and product_id=intent.product_id for update;
  perform 1 from hub.tenant_product_memberships where tenant_id=intent.hub_tenant_id and product_id=intent.product_id and user_id=intent.hub_user_id for update;
  perform 1 from private.case_intake_settings where tenant_id=intent.hub_tenant_id and product_id=intent.product_id for update;
  if intent.applied_at is null and intent.state_digest<>private.support_onboarding_state(p_identity,intent.hub_user_id,intent.hub_tenant_id) then
    raise exception 'Customer access changed. Preview again.' using errcode='40001'; end if;
  if exists(select 1 from private.case_intake_settings where tenant_id=intent.hub_tenant_id and product_id=intent.product_id and enabled) then
    raise exception 'Existing intake requires separate review.' using errcode='42501'; end if;
  if intent.applied_at is null then
    insert into private.federation_issuers(product_id,issuer,audience,jwks_url,enabled,verification_method)
      values(intent.product_id,'urn:caremetric:support:'||product,'support.operator_review',null,false,'operator_review') on conflict(issuer) do nothing;
  end if;
  select id into fid from private.federation_issuers where issuer='urn:caremetric:support:'||product and product_id=intent.product_id
    and audience='support.operator_review' and verification_method='operator_review' and not enabled and jwks_url is null for update;
  if fid is null then raise exception 'Review the existing source configuration.' using errcode='40001'; end if;
  select * into principal from private.federated_principals where issuer_id=fid and external_subject_hash=private.support_identity_hash(p_identity->>'sourceUserId') for update;
  if found and (principal.hub_user_id<>intent.hub_user_id or principal.revoked_at is not null) then
    raise exception 'Existing principal cannot be repointed or restored.' using errcode='40001'; end if;
  select hub_tenant_id into prior_tenant from private.federated_tenants where issuer_id=fid and external_tenant_hash=private.support_identity_hash(p_identity->>'sourceAccountId') for update;
  if prior_tenant is not null and prior_tenant<>intent.hub_tenant_id then raise exception 'Existing account cannot be repointed.' using errcode='40001'; end if;
  if intent.applied_at is not null and (principal.hub_user_id is null or prior_tenant is null) then
    raise exception 'Existing identity binding requires review.' using errcode='40001'; end if;
  if intent.applied_at is null then
    if prior_tenant is null then
      insert into hub.tenants(id,slug,name) values(intent.hub_tenant_id,'support-'||intent.hub_tenant_id::text,intent.tenant_name);
      insert into private.federated_tenants(issuer_id,external_tenant_hash,hub_tenant_id) values(fid,private.support_identity_hash(p_identity->>'sourceAccountId'),intent.hub_tenant_id);
      insert into hub.tenant_products(tenant_id,product_id) values(intent.hub_tenant_id,intent.product_id);
    end if;
    insert into private.federated_principals(issuer_id,external_subject_hash,hub_user_id) values(fid,private.support_identity_hash(p_identity->>'sourceUserId'),intent.hub_user_id) on conflict do nothing;
    insert into hub.tenant_product_memberships(tenant_id,product_id,user_id,role,case_scope,can_manage_members)
      values(intent.hub_tenant_id,intent.product_id,intent.hub_user_id,'customer','own',false) on conflict do nothing;
    insert into private.case_intake_settings(tenant_id,product_id,enabled) values(intent.hub_tenant_id,intent.product_id,false) on conflict do nothing;
  end if;
  select * into member from hub.tenant_product_memberships where tenant_id=intent.hub_tenant_id and product_id=intent.product_id and user_id=intent.hub_user_id;
  if member.user_id is null or member.status<>'active' or member.revoked_at is not null or member.role<>'customer' or member.case_scope<>'own' or member.can_manage_members
    or not exists(select 1 from hub.tenants t join hub.tenant_products p on p.tenant_id=t.id where t.id=intent.hub_tenant_id and p.product_id=intent.product_id and t.status='active' and p.status='active') then
    raise exception 'Existing access requires separate review.' using errcode='42501'; end if;
  perform private.support_onboarding_user(intent.hub_user_id);
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  if intent.applied_at is not null then return intent.result||jsonb_build_object('replayed',true); end if;
  v_result:=jsonb_build_object('intentId',intent.id,'hubTenantId',intent.hub_tenant_id,'hubUserId',intent.hub_user_id,'product',product,
    'replayed',false,'access','customer','caseScope','own','intakeEnabled',false);
  update private.support_onboarding_intents set applied_at=now(),request_id=p_request_id,result=v_result where id=intent.id;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,tenant_id,product_id,metadata)
    values(p_actor_id,'support.customer.link','tenant',intent.hub_tenant_id,intent.hub_tenant_id,intent.product_id,
      jsonb_build_object('intentId',intent.id,'requestId',p_request_id,'hubUserId',intent.hub_user_id,'reviewed',true,'intakeEnabled',false));
  return v_result;
end; $$;

revoke all on function private.require_support_onboarding_actor(uuid,uuid),private.support_identity_hash(text),private.validate_support_identity(jsonb),
  private.support_onboarding_user(uuid),private.support_onboarding_state(jsonb,uuid,uuid),private.support_onboarding_view(private.support_onboarding_intents) from public,anon,authenticated,service_role,hub_app_server;
revoke all on function hub.prepare_support_onboarding(uuid,uuid,jsonb,uuid,text),hub.inspect_support_onboarding(uuid,uuid,uuid,text,uuid),
  hub.apply_support_onboarding(uuid,uuid,uuid,text,uuid,jsonb,boolean) from public,anon,authenticated,service_role;
grant execute on function hub.prepare_support_onboarding(uuid,uuid,jsonb,uuid,text),hub.inspect_support_onboarding(uuid,uuid,uuid,text,uuid),
  hub.apply_support_onboarding(uuid,uuid,uuid,text,uuid,jsonb,boolean) to hub_app_server;

-- 20260911195910_billing_portal_backend_contract.sql
-- Additive compatibility only: Stripe/native configuration remains runtime state.
do $$
declare signature text;
begin
  if to_regprocedure('hub.get_backend_contract()') is null then
    raise exception 'Apply the reviewed billing portal foundation first' using errcode='55000';
  end if;
  if (hub.get_backend_contract() @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1","learning.draft-editing.v1"]}'::jsonb) is not true then
    raise exception 'Apply the reviewed combined editing contract before billing portal declaration' using errcode='55000';
  end if;
  if to_regclass('private.billing_portal_intents') is null
    or to_regtype('private.billing_portal_action') is null then
    raise exception 'Apply the reviewed billing portal intent table and action enum first' using errcode='55000';
  end if;
  foreach signature in array array[
    'hub.authorize_app_command()',
    'private.current_app_session_verified()',
    'private.billing_portal_actor()',
    'private.billing_portal_intent_view(private.billing_portal_intents)',
    'private.require_billing_portal_intent(uuid)',
    'private.resume_billing_portal(uuid)',
    'private.reserve_billing_portal(jsonb)',
    'private.dispatch_billing_portal_preview(uuid)',
    'private.remember_billing_portal_preview(uuid,jsonb)',
    'private.claim_billing_portal(uuid,text)',
    'private.record_billing_portal_result(uuid,jsonb)',
    'private.discard_billing_portal(uuid)'
  ] loop
    if to_regprocedure(signature) is null then
      raise exception 'Apply reviewed billing portal migration first; missing function %',signature using errcode='55000';
    end if;
  end loop;
  if enum_range(null::private.billing_portal_action)::text[] is distinct from array['billing.portal.create']::text[]
    or not exists(select 1 from pg_catalog.pg_attribute a
      where a.attrelid='private.billing_portal_intents'::regclass and a.attname='action'
        and not a.attisdropped and a.attnotnull and a.atttypid='private.billing_portal_action'::regtype)
    or position('''billing.portal.create''' in pg_catalog.pg_get_functiondef('private.reserve_billing_portal(jsonb)'::regprocedure))=0 then
    raise exception 'Apply the reviewed closed billing portal action contract first' using errcode='55000';
  end if;
end;
$$;
create or replace function hub.get_backend_contract() returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('api_version',4,'features',jsonb_build_array(
    'learning.runtime.v1','platform.admin.read.v1','app.sms.v1','learning.sources.v1',
    'platform.admin.command.v1','learning.receipts.v1','learning.authoring.v1',
    'knowledge.publications.v1','support.readiness.v1','platform.admin.intel.v1',
    'learning.draft-editing.v1','billing.portal.v1'));
$$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- 20260911200100_support_customer_onboarding_contract.sql
-- Keep the deployed feature union, including any independently reviewed feature.
do $migration$
declare signature text; contract jsonb;
begin
  if to_regprocedure('hub.get_backend_contract()') is null then
    raise exception 'Apply the combined Hub contract first' using errcode='55000';
  end if;
  contract:=hub.get_backend_contract();
  if (contract @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1","learning.draft-editing.v1","billing.portal.v1"]}'::jsonb) is not true
    or to_regclass('private.support_onboarding_intents') is null then
    raise exception 'Apply reviewed onboarding and the combined Hub foundation first' using errcode='55000';
  end if;
  foreach signature in array array[
    'private.require_support_onboarding_actor(uuid,uuid)', 'private.validate_support_identity(jsonb)',
    'private.support_onboarding_user(uuid)', 'private.support_onboarding_state(jsonb,uuid,uuid)',
    'hub.prepare_support_onboarding(uuid,uuid,jsonb,uuid,text)',
    'hub.inspect_support_onboarding(uuid,uuid,uuid,text,uuid)',
    'hub.apply_support_onboarding(uuid,uuid,uuid,text,uuid,jsonb,boolean)'
  ] loop
    if to_regprocedure(signature) is null then raise exception 'Missing reviewed onboarding function %',signature using errcode='55000'; end if;
  end loop;
  if not (contract->'features' @> '["support.customer-onboarding.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.customer-onboarding.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select '||quote_literal(contract::text)||'::jsonb');
end;
$migration$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- 20260911202021_learning_structure_intents.sql
-- Extend exact source-bound authoring to atomic lesson and assessment edits.
create or replace function private.learning_authoring_actions() returns text[]
language sql immutable security invoker set search_path='' as $$
  select array['learning.cloneVersion','learning.publishVersion','learning.patchDraft','learning.reviewDraft','learning.editStructure']::text[];
$$;
revoke all on function private.learning_authoring_actions() from public,anon,authenticated,hub_app_server;

create or replace function hub.record_learning_authoring_result(p_command_id uuid,p_expected_digest text,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.learning_authoring_intents%rowtype; actor jsonb; source_item uuid;
begin
  actor:=hub.authorize_app_command();
  perform hub.get_learning_authoring_intent(p_command_id,p_expected_digest);
  select * into intent from private.learning_authoring_intents where command_id=p_command_id for update;
  if p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>8000
    or not(p_result ?& array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed'])
    or p_result-array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed','sourceRevision']<>'{}'::jsonb
    or ((p_result->>'action' in ('learning.patchDraft','learning.reviewDraft','learning.editStructure')) is distinct from (p_result ? 'sourceRevision'))
    or (p_result ? 'sourceRevision' and coalesce(p_result->>'sourceRevision','') !~ '^[0-9a-f]{64}$')
    or p_result->>'commandId' is distinct from intent.preview->>'commandId'
    or p_result->>'courseId' is distinct from intent.preview->>'courseId'
    or p_result->>'action' is distinct from intent.preview->>'action'
    or p_result->>'status' is distinct from intent.preview->'after'->>'status'
    or p_result->'versionNumber' is distinct from intent.preview->'after'->'versionNumber'
    or coalesce(p_result->>'versionId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or jsonb_typeof(p_result->'replayed') is distinct from 'boolean'
    or (p_result->>'action'<>'learning.cloneVersion' and p_result->>'versionId' is distinct from intent.preview->'before'->>'versionId')
    or (p_result->>'action'='learning.cloneVersion' and p_result->>'versionId' is not distinct from intent.preview->'before'->>'versionId') then
    raise exception 'The native outcome does not match the preview.' using errcode='22023';
  end if;
  if intent.result is not null then
    if intent.result-'replayed' is distinct from p_result-'replayed' then
      raise exception 'The native result changed.' using errcode='40001';
    end if;
    return intent.result||jsonb_build_object('replayed',true);
  end if;
  update private.learning_authoring_intents set result=p_result,completed_at=now() where command_id=p_command_id;
  select item_id into source_item from private.learning_source_snapshots where id=intent.snapshot_id;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values((actor->>'user_id')::uuid,'learning.authoring.applied','content_item',source_item,
      jsonb_build_object('command_id',p_command_id,'action',p_result->>'action','version_id',p_result->>'versionId'));
  return p_result;
end;
$$;
revoke all on function hub.remember_learning_authoring_preview(uuid,jsonb),hub.get_learning_authoring_intent(uuid,text),hub.record_learning_authoring_result(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function hub.remember_learning_authoring_preview(uuid,jsonb),hub.get_learning_authoring_intent(uuid,text),hub.record_learning_authoring_result(uuid,text,jsonb) to authenticated;

-- Preserve the deployed validator and its ACL; tighten recognized credential
-- field spellings in authored JSON without rewriting source evidence.
create or replace function private.validate_governed_learning_source(p_payload text, p_revision text) returns jsonb
language plpgsql set search_path='' as $$
declare document jsonb;
begin
  if p_payload is null or octet_length(p_payload)>2000000 or p_revision is null
    or p_revision !~ '^[0-9a-f]{64}$'
    or encode(extensions.digest(p_payload,'sha256'),'hex')<>p_revision then
    raise exception 'Source revision checksum or size is invalid.' using errcode='22023';
  end if;
  begin document:=p_payload::jsonb;
  exception when invalid_text_representation then
    raise exception 'Source payload is not valid JSON.' using errcode='22023';
  end;
  if not extensions.jsonb_matches_schema(private.governed_learning_schema(),document) then
    raise exception 'Source snapshot does not match carebase.course.v1.' using errcode='22023';
  end if;
  if document::text ~* '([?&](token|access_token|signature|sig|key|policy|jwt|auth|h|hdnts|hdnea|key-pair-id|api_key|apikey|x-amz-[a-z-]+|x-goog-[a-z-]+)=|"(access_?token|refresh_?token|service_?role_?key|authorization|password|client_?secret|storage_?(path|bucket)|video_?url|playback_?(url|token)|signed_?url|api_?key|token|secret|secret_?key|signing_?secret)"[[:space:]]*:)' then
    raise exception 'Remove playback credentials from the source export before staging.' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(document->'blocks') b
    where (b->>'type'<>'quiz' and b->'quiz'<>'null'::jsonb)
      or (b->>'type'='quiz' and b->'quiz'='null'::jsonb and document->>'sourceVersionState'<>'draft')
      or ((b->'quiz'->>'revealsAnswersAfterAttempt')::boolean and b->'quiz'->>'kind'<>'knowledge_check')) then
    raise exception 'Source quiz configuration is invalid.' using errcode='22023';
  end if;
  if exists(
    with blocks as(select value b from jsonb_array_elements(document->'blocks')),
    questions as(select q from blocks cross join lateral jsonb_array_elements(coalesce(nullif(b->'quiz'->'questions','null'::jsonb),'[]'::jsonb)) q),
    ids as (
      select 'block' kind, lower(b->>'id') id from blocks
      union all select 'quiz',lower(b->'quiz'->>'id') from blocks where b->'quiz'<>'null'::jsonb
      union all select 'question',lower(q->>'id') from questions
      union all select 'answer',lower(a->>'id') from questions cross join lateral jsonb_array_elements(q->'options') a
      union all select 'credit',lower(c->>'id') from jsonb_array_elements(document->'credits') c
      union all select 'package',lower(p->>'id') from jsonb_array_elements(document->'packages') p
    ) select 1 from ids group by kind,id having count(*)>1
  ) then raise exception 'The source snapshot repeats a content identifier.' using errcode='22023'; end if;
  return document;
end;
$$;

-- 20260911202823_learning_structure_backend_contract.sql
-- The structure editor needs atomic native intents and readable incomplete drafts.
do $$
declare signature text;
begin
  if (hub.get_backend_contract() @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1","learning.draft-editing.v1","billing.portal.v1"]}'::jsonb) is not true then
    raise exception 'Apply the complete portal and editing foundation before structure declaration' using errcode='55000';
  end if;
  foreach signature in array array['private.learning_authoring_actions()', 'hub.remember_learning_authoring_preview(uuid,jsonb)',
    'hub.get_learning_authoring_intent(uuid,text)', 'hub.record_learning_authoring_result(uuid,text,jsonb)',
    'private.validate_governed_learning_source(text,text)'] loop
    if to_regprocedure(signature) is null then
      raise exception 'Missing reviewed structure boundary: %', signature using errcode='55000';
    end if;
  end loop;
  if private.learning_authoring_actions() is distinct from array['learning.cloneVersion','learning.publishVersion','learning.patchDraft','learning.reviewDraft','learning.editStructure']::text[]
    or position('private.learning_authoring_actions()' in pg_catalog.pg_get_functiondef('hub.remember_learning_authoring_preview(uuid,jsonb)'::regprocedure))=0
    or position('''learning.editStructure''' in pg_catalog.pg_get_functiondef('hub.record_learning_authoring_result(uuid,text,jsonb)'::regprocedure))=0
    or position('''sourceVersionState''' in pg_catalog.pg_get_functiondef('private.validate_governed_learning_source(text,text)'::regprocedure))=0 then
    raise exception 'Apply the closed structure intentions and incomplete draft reader first' using errcode='55000';
  end if;
end;
$$;
-- Preserve independently reviewed features declared by earlier migrations.
-- Capture a literal; the public metadata function never reads private tables.
do $declaration$
declare contract jsonb:=hub.get_backend_contract(); features jsonb;
begin
  features:=contract->'features';
  if jsonb_typeof(features) is distinct from 'array' or jsonb_array_length(features)>99
    or exists(select 1 from jsonb_array_elements(features) value where jsonb_typeof(value)<>'string')
    or (select count(*)<>count(distinct value) from jsonb_array_elements(features) value) then
    raise exception 'Invalid prior structure feature declaration' using errcode='55000';
  end if;
  if not(features ? 'learning.structure.v1') then features:=features||'["learning.structure.v1"]'::jsonb; end if;
  contract:=jsonb_build_object('api_version',4,'features',features);
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    format('select %L::jsonb',contract::text));
end;
$declaration$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- 20260911202906_billing_checkout_intents.sql
-- Hub owns reviewed request/session recovery. Native CareBase alone owns the
-- organization-wide reservation, immutable provider parameters and Stripe key.
create type private.billing_checkout_action as enum ('billing.checkout.create','billing.checkout.recover');
create table private.billing_checkout_intents (
  request_id uuid primary key,
  actor_id uuid not null references hub.profiles(id),
  session_id uuid not null references private.sms_sessions(id),
  organization_id uuid not null,
  action private.billing_checkout_action not null default 'billing.checkout.create',
  request jsonb not null check(octet_length(request::text)<=4096),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  preview_dispatched_at timestamptz,
  command_id uuid unique,
  preview jsonb check(octet_length(preview::text)<=8192),
  preview_expires_at timestamptz,
  dispatched_at timestamptz,
  observation_id uuid,
  provider_session_id text check(provider_session_id ~ '^cs_(test|live)_[A-Za-z0-9]+$' and length(provider_session_id)<=255),
  result jsonb check(octet_length(result::text)<=4096),
  recovery jsonb check(octet_length(recovery::text)<=256),
  retry_at timestamptz,
  discarded_at timestamptz,
  check((preview is null)=(command_id is null)),
  check((preview is null)=(preview_expires_at is null)),
  check(result is null or dispatched_at is not null),
  check(observation_id is null or dispatched_at is not null),
  check(discarded_at is null or preview_dispatched_at is null)
);
create index billing_checkout_actor_idx on private.billing_checkout_intents(actor_id,created_at);
create index billing_checkout_session_idx on private.billing_checkout_intents(session_id,organization_id,created_at);
create index billing_checkout_created_idx on private.billing_checkout_intents(created_at);
create index billing_checkout_expiry_idx on private.billing_checkout_intents(expires_at);
alter table private.billing_checkout_intents enable row level security;
revoke all on private.billing_checkout_intents from public,anon,authenticated,service_role,hub_app_server;

create function private.billing_checkout_intent_view(p_intent private.billing_checkout_intents) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('request',p_intent.request,'preview',p_intent.preview,'result',p_intent.result,
    'createdAt',p_intent.created_at,'expiresAt',p_intent.expires_at,'previewDispatchedAt',p_intent.preview_dispatched_at,
    'dispatchedAt',p_intent.dispatched_at,'retryAt',p_intent.retry_at,'recovery',p_intent.recovery);
$$;
create function private.require_billing_checkout_intent(p_request_id uuid) returns private.billing_checkout_intents
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_intent private.billing_checkout_intents;
begin
  -- Reuse the existing billing actor boundary, including the dedicated server
  -- session_user and current Hub/SMS authority. No browser role grants.
  v_actor:=private.billing_portal_actor();
  select * into v_intent from private.billing_checkout_intents where request_id=p_request_id for update;
  if not found or v_intent.actor_id is distinct from (v_actor->>'user_id')::uuid
    or v_intent.session_id is distinct from (v_actor->>'session_id')::uuid or v_intent.expires_at<=now() or v_intent.discarded_at is not null then
    raise exception 'Checkout review unavailable.' using errcode='42501';
  end if;
  return v_intent;
end;
$$;
create function private.resume_billing_checkout(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_intent private.billing_checkout_intents;
begin
  v_actor:=private.billing_portal_actor();
  select * into v_intent from private.billing_checkout_intents where organization_id=p_organization_id
    and actor_id=(v_actor->>'user_id')::uuid and session_id=(v_actor->>'session_id')::uuid
    and expires_at>now() and discarded_at is null order by created_at desc,request_id desc limit 1;
  if not found then return null; end if;
  return private.billing_checkout_intent_view(v_intent);
end;
$$;
create function private.reserve_billing_checkout(p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_intent private.billing_checkout_intents; v_request_id uuid; v_organization_id uuid; v_package_id uuid;
begin
  v_actor:=private.billing_portal_actor();
  if p_request is null or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>4096
    or jsonb_typeof(p_request->'reason') is distinct from 'string' or coalesce(length(p_request->>'reason'),0) not between 10 and 500
    or p_request->>'reason'<>btrim(p_request->>'reason') or p_request->>'reason' ~ '[[:cntrl:]]' then
    raise exception 'Invalid checkout review.' using errcode='22023';
  end if;
  if p_request->>'operation'='recover' and p_request->>'action'='billing.checkout.recover' then
    if not(p_request ?& array['operation','requestId','action','targetId','reason'])
      or p_request-array['operation','requestId','action','targetId','reason']<>'{}'::jsonb then
      raise exception 'Invalid checkout recovery.' using errcode='22023';
    end if;
  elsif p_request->>'operation'='preview' and p_request->>'action'='billing.checkout.create' then
    if not(p_request ?& array['operation','requestId','action','targetId','parameters','reason'])
      or p_request-array['operation','requestId','action','targetId','parameters','reason']<>'{}'::jsonb
      or jsonb_typeof(p_request->'parameters') is distinct from 'object'
      or not((p_request->'parameters') ?& array['packageId','billingInterval'])
      or (p_request->'parameters')-array['packageId','billingInterval']<>'{}'::jsonb
      or coalesce(p_request#>>'{parameters,billingInterval}','') not in ('month','year') then
      raise exception 'Invalid checkout review.' using errcode='22023';
    end if;
    begin v_package_id:=(p_request#>>'{parameters,packageId}')::uuid;
    exception when others then raise exception 'Invalid checkout package.' using errcode='22023'; end;
    if v_package_id is null then raise exception 'Invalid checkout package.' using errcode='22023'; end if;
  else raise exception 'Invalid checkout action.' using errcode='22023'; end if;
  begin v_request_id:=(p_request->>'requestId')::uuid; v_organization_id:=(p_request->>'targetId')::uuid;
  exception when others then raise exception 'Invalid checkout identity.' using errcode='22023'; end;
  if v_request_id is null or v_organization_id is null then raise exception 'Invalid checkout identity.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing.checkout.reserve',0));
  delete from private.billing_checkout_intents where expires_at<now()-interval '30 days';
  select * into v_intent from private.billing_checkout_intents where request_id=v_request_id;
  if found then
    v_intent:=private.require_billing_checkout_intent(v_request_id);
    if v_intent.request is distinct from p_request then raise exception 'Checkout request key changed.' using errcode='40001'; end if;
    return private.billing_checkout_intent_view(v_intent);
  end if;
  if p_request->>'operation'<>'recover' and exists(select 1 from (select * from private.billing_checkout_intents where organization_id=v_organization_id
    and actor_id=(v_actor->>'user_id')::uuid and session_id=(v_actor->>'session_id')::uuid and expires_at>now() and discarded_at is null order by created_at desc,request_id desc limit 1) latest
    where (result is null or result->'canStartNewCheckout' is distinct from 'true'::jsonb)
    and (recovery is null or recovery->'canStartNewCheckout' is distinct from 'true'::jsonb)
    and (dispatched_at is not null or preview_expires_at>now() or (preview is null and created_at>now()-interval '6 minutes'))) then
    raise exception 'Resume the reserved checkout.' using errcode='40001';
  end if;
  if (select count(*) from private.billing_checkout_intents where created_at>now()-interval '1 hour')>=200
    or (select count(*) from private.billing_checkout_intents where actor_id=(v_actor->>'user_id')::uuid and created_at>now()-interval '1 hour')>=20 then
    raise exception 'Checkout review limit reached.' using errcode='54000';
  end if;
  insert into private.billing_checkout_intents(request_id,actor_id,session_id,organization_id,action,request,expires_at)
    values(v_request_id,(v_actor->>'user_id')::uuid,(v_actor->>'session_id')::uuid,v_organization_id,(p_request->>'action')::private.billing_checkout_action,p_request,(v_actor->>'assurance_expires_at')::timestamptz)
    returning * into v_intent;
  return private.billing_checkout_intent_view(v_intent);
end;
$$;
create function private.dispatch_billing_checkout_preview(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.billing_checkout_intents;
begin
  v_intent:=private.require_billing_checkout_intent(p_request_id);
  update private.billing_checkout_intents set preview_dispatched_at=coalesce(preview_dispatched_at,now())
    where request_id=p_request_id returning * into v_intent;
  return private.billing_checkout_intent_view(v_intent);
end;
$$;
create function private.remember_billing_checkout_preview(p_request_id uuid,p_preview jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.billing_checkout_intents; v_summary jsonb; v_command_id uuid; v_expires timestamptz;
begin
  v_intent:=private.require_billing_checkout_intent(p_request_id); v_summary:=p_preview->'summary';
  if v_intent.action<>'billing.checkout.create' or v_intent.preview_dispatched_at is null or p_preview is null or jsonb_typeof(p_preview)<>'object'
    or octet_length(p_preview::text)>8192 or not(p_preview ?& array['commandId','action','targetId','reason','expiresAt','previewDigest','summary'])
    or p_preview-array['commandId','action','targetId','reason','expiresAt','previewDigest','summary']<>'{}'::jsonb
    or p_preview->>'action' is distinct from 'billing.checkout.create' or p_preview->>'targetId' is distinct from v_intent.request->>'targetId'
    or p_preview->>'reason' is distinct from v_intent.request->>'reason' or coalesce(p_preview->>'previewDigest','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(v_summary) is distinct from 'object'
    or not(v_summary ?& array['kind','organizationName','packageId','billingInterval','intervalCount','currency','billingMetric','quantity','providerPriceId','providerCustomerId','trialDays'])
    or v_summary-array['kind','organizationName','packageId','billingInterval','intervalCount','currency','billingMetric','quantity','providerPriceId','providerCustomerId','trialDays']<>'{}'::jsonb
    or v_summary->>'kind' is distinct from 'checkout'
    or v_summary->>'packageId' is distinct from v_intent.request#>>'{parameters,packageId}'
    or v_summary->>'billingInterval' is distinct from v_intent.request#>>'{parameters,billingInterval}'
    or coalesce(v_summary->>'currency','') !~ '^[a-z]{3}$'
    or coalesce(v_summary->>'billingMetric','') not in ('flat','active_learner','active_user','active_resident','facility')
    or jsonb_typeof(v_summary->'intervalCount') is distinct from 'number' or coalesce(v_summary->>'intervalCount','') !~ '^[0-9]+$'
    or (v_summary->>'intervalCount')::numeric not between 1 and 36
    or jsonb_typeof(v_summary->'quantity') is distinct from 'number' or coalesce(v_summary->>'quantity','') !~ '^[0-9]+$'
    or (v_summary->>'quantity')::numeric not between 1 and 9007199254740991
    or jsonb_typeof(v_summary->'trialDays') is distinct from 'number' or coalesce(v_summary->>'trialDays','') !~ '^[0-9]+$'
    or (v_summary->>'trialDays')::numeric not between 0 and 90
    or coalesce(v_summary->>'providerPriceId','') !~ '^price_[A-Za-z0-9]+$'
    or (v_summary->'providerCustomerId'<>'null'::jsonb and coalesce(v_summary->>'providerCustomerId','') !~ '^cus_[A-Za-z0-9]+$')
    or jsonb_typeof(v_summary->'organizationName') is distinct from 'string' or length(v_summary->>'organizationName')>500 then
    raise exception 'Invalid native checkout preview.' using errcode='22023';
  end if;
  begin v_command_id:=(p_preview->>'commandId')::uuid; v_expires:=(p_preview->>'expiresAt')::timestamptz;
  exception when others then raise exception 'Invalid checkout preview identity.' using errcode='22023'; end;
  if v_command_id is null or v_expires is null or not isfinite(v_expires) or v_expires>clock_timestamp()+interval '5 minutes 1 second' then
    raise exception 'Invalid checkout preview lifetime.' using errcode='22023';
  end if;
  if v_intent.preview is not null then
    if v_intent.preview is distinct from p_preview then raise exception 'Checkout preview changed.' using errcode='40001'; end if;
    return private.billing_checkout_intent_view(v_intent);
  end if;
  if v_expires<=clock_timestamp() then raise exception 'Checkout preview expired.' using errcode='40001'; end if;
  update private.billing_checkout_intents set command_id=v_command_id,preview=p_preview,preview_expires_at=v_expires
    where request_id=p_request_id returning * into v_intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(v_intent.actor_id,'billing.checkout.preview','native_organization',v_intent.organization_id,jsonb_build_object('command_id',v_command_id));
  return private.billing_checkout_intent_view(v_intent);
end;
$$;
create function private.claim_billing_checkout(p_command_id uuid,p_expected_digest text,p_check_only boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.billing_checkout_intents; v_request_id uuid;
begin
  perform private.billing_portal_actor();
  select request_id into v_request_id from private.billing_checkout_intents where command_id=p_command_id;
  v_intent:=private.require_billing_checkout_intent(v_request_id);
  if v_intent.action='billing.checkout.recover' and p_check_only is not true then raise exception 'Recovery cannot create checkout.' using errcode='42501'; end if;
  if p_check_only is null or p_expected_digest is distinct from v_intent.preview->>'previewDigest' then raise exception 'Checkout review changed.' using errcode='40001'; end if;
  if v_intent.dispatched_at is null and (p_check_only or v_intent.preview_expires_at<=clock_timestamp()) then
    raise exception 'Checkout has not been applied or its review expired.' using errcode='40001';
  end if;
  update private.billing_checkout_intents set dispatched_at=coalesce(dispatched_at,now()),observation_id=gen_random_uuid()
    where request_id=v_request_id returning * into v_intent;
  return jsonb_build_object('intent',private.billing_checkout_intent_view(v_intent),'observationId',v_intent.observation_id);
end;
$$;
create function private.record_billing_checkout_result(p_command_id uuid,p_observation_id uuid,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.billing_checkout_intents; v_request_id uuid; v_outcome text; v_session jsonb; v_checked timestamptz; v_expires timestamptz;
begin
  perform private.billing_portal_actor();
  select request_id into v_request_id from private.billing_checkout_intents where command_id=p_command_id;
  v_intent:=private.require_billing_checkout_intent(v_request_id);
  if p_observation_id is null or v_intent.observation_id is distinct from p_observation_id then
    raise exception 'Checkout observation superseded.' using errcode='40001';
  end if;
  v_outcome:=p_result->>'outcome'; v_session:=p_result->'session';
  if v_intent.dispatched_at is null or p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>4096
    or not(p_result ?& array['commandId','action','targetId','outcome','replayed','checkedAt','providerStatus','availability','canStartNewCheckout','retryAfterSeconds','session'])
    or p_result-array['commandId','action','targetId','outcome','replayed','checkedAt','providerStatus','availability','canStartNewCheckout','retryAfterSeconds','session']<>'{}'::jsonb
    or p_result->>'commandId' is distinct from p_command_id::text or p_result->>'targetId' is distinct from v_intent.organization_id::text
    or p_result->>'action' is distinct from v_intent.action::text or coalesce(v_outcome,'') not in ('open','complete','expired','pending','failed')
    or jsonb_typeof(p_result->'replayed') is distinct from 'boolean' or jsonb_typeof(p_result->'canStartNewCheckout') is distinct from 'boolean'
    or coalesce(p_result->>'availability','') not in ('available','unavailable')
    or jsonb_typeof(p_result->'checkedAt') not in ('string','null')
    or (p_result->'providerStatus'<>'null'::jsonb and coalesce(p_result->>'providerStatus','') not in ('open','complete','expired'))
    or (v_outcome in ('open','pending') and p_result->'canStartNewCheckout' is distinct from 'false'::jsonb)
    or (v_outcome='pending' and (p_result->'retryAfterSeconds' is distinct from '30'::jsonb or v_session is distinct from 'null'::jsonb))
    or (v_outcome<>'pending' and (p_result->>'availability' is distinct from 'available' or jsonb_typeof(p_result->'checkedAt') is distinct from 'string'
      or p_result->'retryAfterSeconds' is distinct from 'null'::jsonb))
    or (v_outcome in ('complete','expired') and p_result->>'providerStatus' is distinct from v_outcome)
    or (v_outcome='failed' and p_result->'providerStatus' is distinct from 'null'::jsonb)
    or (v_outcome<>'open' and v_session is distinct from 'null'::jsonb)
    or (v_outcome='open' and (p_result->>'providerStatus' is distinct from 'open' or jsonb_typeof(v_session) is distinct from 'object'
      or not(v_session ?& array['kind','id','expiresAt','livemode']) or v_session-array['kind','id','expiresAt','livemode']<>'{}'::jsonb
      or v_session->>'kind' is distinct from 'checkout' or coalesce(v_session->>'id','') !~ '^cs_(test|live)_[A-Za-z0-9]+$'
      or length(v_session->>'id')>255 or jsonb_typeof(v_session->'livemode') is distinct from 'boolean'
      or ((v_session->>'id' like 'cs_live_%') is distinct from (v_session->>'livemode')::boolean))) then
    raise exception 'Invalid redacted checkout result.' using errcode='22023';
  end if;
  begin
    v_checked:=(p_result->>'checkedAt')::timestamptz; v_expires:=(v_session->>'expiresAt')::timestamptz;
  exception when others then raise exception 'Invalid checkout result time.' using errcode='22023'; end;
  if (v_checked is not null and not isfinite(v_checked)) or (v_outcome='open' and (v_expires is null or not isfinite(v_expires) or v_expires<=clock_timestamp())) then
    raise exception 'Checkout result unavailable or expired.' using errcode='40001';
  end if;
  if v_outcome='open' and v_intent.provider_session_id is not null and v_intent.provider_session_id is distinct from v_session->>'id' then
    raise exception 'Native checkout session changed.' using errcode='40001';
  end if;
  update private.billing_checkout_intents set result=p_result,
    recovery=case when action='billing.checkout.recover' then jsonb_build_object('checkedAt',now(),'canStartNewCheckout',p_result->'canStartNewCheckout') end, retry_at=case when v_outcome='pending' then now()+interval '30 seconds' end,
    provider_session_id=coalesce(provider_session_id,v_session->>'id')
    where request_id=v_request_id returning * into v_intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(v_intent.actor_id,'billing.checkout.result','native_organization',v_intent.organization_id,jsonb_build_object('command_id',p_command_id,'outcome',v_outcome));
  return private.billing_checkout_intent_view(v_intent);
end;
$$;
create function private.claim_billing_checkout_recovery(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.billing_checkout_intents;
begin
  v_intent:=private.require_billing_checkout_intent(p_request_id);
  if v_intent.action<>'billing.checkout.recover' then raise exception 'Recovery action required.' using errcode='42501'; end if;
  update private.billing_checkout_intents set preview_dispatched_at=coalesce(preview_dispatched_at,now()),
    dispatched_at=coalesce(dispatched_at,now()),observation_id=gen_random_uuid()
    where request_id=p_request_id returning * into v_intent;
  return jsonb_build_object('intent',private.billing_checkout_intent_view(v_intent),'observationId',v_intent.observation_id);
end;
$$;
create function private.remember_billing_checkout_recovery(p_request_id uuid,p_observation_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.billing_checkout_intents; v_preview jsonb; v_result jsonb; v_summary jsonb; v_command uuid; v_package uuid; v_expires timestamptz;
begin
  v_intent:=private.require_billing_checkout_intent(p_request_id);
  if v_intent.action<>'billing.checkout.recover' or v_intent.dispatched_at is null then raise exception 'Recovery action required.' using errcode='42501'; end if;
  if p_observation_id is null or v_intent.observation_id is distinct from p_observation_id then raise exception 'Checkout observation superseded.' using errcode='40001'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>12288
    or not(p_data ?& array['targetId','preview','result','canStartNewCheckout'])
    or p_data-array['targetId','preview','result','canStartNewCheckout']<>'{}'::jsonb
    or p_data->>'targetId' is distinct from v_intent.organization_id::text
    or jsonb_typeof(p_data->'canStartNewCheckout') is distinct from 'boolean' then
    raise exception 'Invalid checkout recovery result.' using errcode='22023';
  end if;
  v_preview:=p_data->'preview';v_result:=p_data->'result';v_summary:=v_preview->'summary';
  if v_preview='null'::jsonb and v_result='null'::jsonb then
    if v_intent.preview is not null then raise exception 'Original recovery command changed.' using errcode='40001'; end if;
    update private.billing_checkout_intents set recovery=jsonb_build_object('checkedAt',now(),'canStartNewCheckout',p_data->'canStartNewCheckout')
      where request_id=p_request_id returning * into v_intent;
    insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
      values(v_intent.actor_id,'billing.checkout.recover','native_organization',v_intent.organization_id,jsonb_build_object('request_id',p_request_id,'found',false));
    return private.billing_checkout_intent_view(v_intent);
  end if;
  if jsonb_typeof(v_preview) is distinct from 'object' or jsonb_typeof(v_result) is distinct from 'object'
    or not(v_preview ?& array['commandId','action','targetId','reason','expiresAt','previewDigest','summary'])
    or v_preview-array['commandId','action','targetId','reason','expiresAt','previewDigest','summary']<>'{}'::jsonb
    or v_preview->>'action' is distinct from 'billing.checkout.recover'
    or v_preview->>'targetId' is distinct from v_intent.organization_id::text or v_preview->>'reason' is distinct from v_intent.request->>'reason'
    or coalesce(v_preview->>'previewDigest','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(v_summary) is distinct from 'object'
    or not(v_summary ?& array['kind','organizationName','packageId','billingInterval','intervalCount','currency','billingMetric','quantity','providerPriceId','providerCustomerId','trialDays'])
    or v_summary-array['kind','organizationName','packageId','billingInterval','intervalCount','currency','billingMetric','quantity','providerPriceId','providerCustomerId','trialDays']<>'{}'::jsonb
    or v_summary->>'kind' is distinct from 'checkout' or coalesce(v_summary->>'billingInterval','') not in ('month','year')
    or coalesce(v_summary->>'currency','') !~ '^[a-z]{3}$'
    or coalesce(v_summary->>'billingMetric','') not in ('flat','active_learner','active_user','active_resident','facility')
    or jsonb_typeof(v_summary->'intervalCount') is distinct from 'number' or coalesce(v_summary->>'intervalCount','') !~ '^[0-9]+$'
    or (v_summary->>'intervalCount')::numeric not between 1 and 36
    or jsonb_typeof(v_summary->'quantity') is distinct from 'number' or coalesce(v_summary->>'quantity','') !~ '^[0-9]+$'
    or (v_summary->>'quantity')::numeric not between 1 and 9007199254740991
    or jsonb_typeof(v_summary->'trialDays') is distinct from 'number' or coalesce(v_summary->>'trialDays','') !~ '^[0-9]+$'
    or (v_summary->>'trialDays')::numeric not between 0 and 90
    or coalesce(v_summary->>'providerPriceId','') !~ '^price_[A-Za-z0-9]+$' or length(v_summary->>'providerPriceId')>255
    or (v_summary->'providerCustomerId'<>'null'::jsonb and (coalesce(v_summary->>'providerCustomerId','') !~ '^cus_[A-Za-z0-9]+$' or length(v_summary->>'providerCustomerId')>255))
    or jsonb_typeof(v_summary->'organizationName') is distinct from 'string' or length(v_summary->>'organizationName')>500
    or v_result->'canStartNewCheckout' is distinct from p_data->'canStartNewCheckout' then
    raise exception 'Invalid original checkout terms.' using errcode='22023';
  end if;
  begin v_command:=(v_preview->>'commandId')::uuid;v_package:=(v_summary->>'packageId')::uuid;v_expires:=(v_preview->>'expiresAt')::timestamptz;
  exception when others then raise exception 'Invalid recovery identity.' using errcode='22023'; end;
  if v_command is null or v_package is null or v_expires is null or not isfinite(v_expires) or v_expires>clock_timestamp()+interval '5 minutes 1 second' then
    raise exception 'Invalid recovery lifetime.' using errcode='22023';
  end if;
  -- Recovery creates no provider capability. Its original inspection preview
  -- may expire while GET-only checks remain valid in the current SMS session.
  if v_intent.preview is not null and v_intent.preview is distinct from v_preview then raise exception 'Original recovery terms changed.' using errcode='40001'; end if;
  update private.billing_checkout_intents set command_id=v_command,preview=v_preview,preview_expires_at=v_expires where request_id=p_request_id;
  return private.record_billing_checkout_result(v_command,p_observation_id,v_result);
end;
$$;
create function private.discard_billing_checkout(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.billing_checkout_intents;
begin
  v_intent:=private.require_billing_checkout_intent(p_request_id);
  if v_intent.preview_dispatched_at is not null or v_intent.dispatched_at is not null then raise exception 'Dispatched checkout review must keep its identity.' using errcode='40001'; end if;
  update private.billing_checkout_intents set discarded_at=now() where request_id=p_request_id;
  return jsonb_build_object('discarded',true);
end;
$$;
revoke all on function private.billing_checkout_intent_view(private.billing_checkout_intents),private.require_billing_checkout_intent(uuid),
  private.resume_billing_checkout(uuid),private.reserve_billing_checkout(jsonb),private.dispatch_billing_checkout_preview(uuid),
  private.remember_billing_checkout_preview(uuid,jsonb),private.claim_billing_checkout(uuid,text,boolean),
  private.record_billing_checkout_result(uuid,uuid,jsonb),private.claim_billing_checkout_recovery(uuid),private.remember_billing_checkout_recovery(uuid,uuid,jsonb),private.discard_billing_checkout(uuid) from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.resume_billing_checkout(uuid),private.reserve_billing_checkout(jsonb),private.dispatch_billing_checkout_preview(uuid),
  private.remember_billing_checkout_preview(uuid,jsonb),private.claim_billing_checkout(uuid,text,boolean),
  private.record_billing_checkout_result(uuid,uuid,jsonb),private.claim_billing_checkout_recovery(uuid),private.remember_billing_checkout_recovery(uuid,uuid,jsonb),private.discard_billing_checkout(uuid) to hub_app_server;

-- 20260911203000_support_customer_registration.sql
-- Invited first-use SMS registration creates no app access. The current native
-- relationship must be reviewed again through customer onboarding before linking.
create table private.support_registration_reviews (
  id uuid primary key default gen_random_uuid(),actor_id uuid not null references auth.users(id),
  session_id uuid not null references private.sms_sessions(id),identity jsonb not null,
  phone_e164 text not null check(phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  display_name text not null check(length(display_name) between 1 and 120),tenant_name text not null check(length(tenant_name) between 2 and 180),
  proof_digest text not null,created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '60 seconds'
);
create index support_registration_review_session_idx on private.support_registration_reviews(session_id,created_at);
create table private.support_registration_invitations (
  id uuid primary key,review_id uuid not null unique references private.support_registration_reviews(id),
  actor_id uuid not null references auth.users(id),session_id uuid not null references private.sms_sessions(id),
  identity jsonb not null,phone_e164 text not null check(phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  display_name text not null,tenant_name text not null,token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '15 minutes',
  revoked_at timestamptz,claimed_at timestamptz,claimed_user_id uuid references auth.users(id),
  check((claimed_at is null)=(claimed_user_id is null))
);
create unique index support_registration_native_unique on private.support_registration_invitations((identity->>'product'),(identity->>'sourceUserId')) where revoked_at is null;
create unique index support_registration_phone_unique on private.support_registration_invitations(phone_e164) where revoked_at is null;
alter table private.sms_challenges add column registration_invitation_id uuid references private.support_registration_invitations(id);
create index sms_challenge_registration_idx on private.sms_challenges(registration_invitation_id);
alter table private.support_registration_reviews enable row level security;
alter table private.support_registration_invitations enable row level security;
revoke all on private.support_registration_reviews,private.support_registration_invitations from public,anon,authenticated,service_role,hub_app_server;

create function private.validate_registration_identity(p_identity jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare pattern text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p_identity->>'product' is distinct from 'carebase' then perform private.validate_support_identity(p_identity);return;end if;
  if jsonb_typeof(p_identity)<>'object' or (select array_agg(key order by key) from jsonb_object_keys(p_identity) key)
    is distinct from array['accountKind','product','relationship','revision','sourceAccountId','sourceUserId']::text[]
    or p_identity->>'accountKind' is distinct from 'organization' or p_identity->>'relationship' is distinct from 'organization_member'
    or coalesce(p_identity->>'sourceUserId','') !~ pattern or coalesce(p_identity->>'sourceAccountId','') !~ pattern
    or coalesce(p_identity->>'revision','') !~ '^[0-9a-f]{64}$' then raise exception 'Verified CareBase relationship required.' using errcode='22023';end if;
end; $$;

create function private.registration_available(p_identity jsonb,p_phone text) returns void
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.validate_registration_identity(p_identity);
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Invalid phone.' using errcode='22023'; end if;
  if exists(select 1 from private.sms_identities where phone_e164=p_phone)
    or exists(select 1 from private.federated_principals p join private.federation_issuers i on i.id=p.issuer_id
      where i.issuer='urn:caremetric:support:'||(p_identity->>'product') and p.external_subject_hash=private.support_identity_hash(p_identity->>'sourceUserId')) then
    raise exception 'Use the existing Hub identity.' using errcode='40001'; end if;
  if p_identity->>'product'='carebase' then
    if exists(select 1 from private.federated_principals p join private.federation_issuers i on i.id=p.issuer_id
      where i.issuer='https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1'
        and p.external_subject_hash=private.carebase_external_identity_hash((p_identity->>'sourceUserId')::uuid)) then
      raise exception 'Use the existing Hub identity.' using errcode='40001';end if;
  end if;
  if not exists(select 1 from hub.products where slug=case p_identity->>'product' when 'intel' then 'caremetric-intel' else p_identity->>'product' end
    and status<>'retired' and support_enabled) then raise exception 'Product unavailable.' using errcode='42501'; end if;
end; $$;

-- The invitation carries no user-supplied administrator identity. Claims use the
-- issuing session captured by the reviewed operation and recheck its live authority.
create function private.registration_issuer_current(i private.support_registration_invitations) returns boolean
language plpgsql security definer set search_path='' as $$
declare prior text:=current_setting('request.jwt.claims',true);allowed boolean:=false;
begin
  if session_user<>'hub_app_server' then return false; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',i.actor_id,'role','authenticated','sms_session_id',i.session_id)::text,true);
  begin
    perform private.require_support_onboarding_actor(i.actor_id,i.session_id);allowed:=true;
  exception when sqlstate '28000' or sqlstate '42501' then allowed:=false;
  end;
  perform set_config('request.jwt.claims',coalesce(prior,''),true);
  return allowed;
end; $$;

create function private.start_registration_challenge(p_invitation_hash text,p_phone text,p_client_hash text,p_browser_hash text,p_challenge_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i private.support_registration_invitations%rowtype;counts record;v_phone_hash text;
begin
  if session_user<>'hub_app_server' then raise exception 'Server required.' using errcode='42501'; end if;
  if p_invitation_hash is null or p_invitation_hash !~ '^[0-9a-f]{64}$' or p_browser_hash is null or p_browser_hash !~ '^[0-9a-f]{64}$'
    or p_client_hash is null or p_client_hash !~ '^[0-9a-f]{64}$' or p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Invalid registration challenge.' using errcode='22023'; end if;
  v_phone_hash:=private.support_identity_hash(p_phone);
  perform pg_advisory_xact_lock(hashtextextended('hub_sms_start',0));
  select count(*) as total,count(*) filter(where c.phone_hash=v_phone_hash) as phone_count,
    count(*) filter(where c.client_hash=p_client_hash) as client_count,
    count(*) filter(where c.phone_hash=v_phone_hash and c.created_at>now()-interval '60 seconds') as recent
    into counts from private.sms_challenges c where c.created_at>now()-interval '15 minutes';
  if counts.total>=100 or counts.phone_count>=5 or counts.client_count>=30 or counts.recent>0 then raise exception 'Wait before requesting another code.' using errcode='P0429'; end if;
  select * into i from private.support_registration_invitations where token_hash=p_invitation_hash and phone_e164=p_phone
    and claimed_at is null and revoked_at is null and expires_at>now() for update;
  if i.id is not null and (not private.registration_issuer_current(i) or exists(select 1 from private.sms_identities where phone_e164=p_phone)) then i:=null; end if;
  -- Failed attempts consume the same persisted quota but do not reveal an invitation or send a message.
  update private.sms_challenges set consumed_at=now() where private.sms_challenges.phone_hash=v_phone_hash and consumed_at is null;
  insert into private.sms_challenges(id,phone_hash,client_hash,browser_hash,registration_invitation_id)
    values(p_challenge_id,v_phone_hash,p_client_hash,p_browser_hash,i.id);
  return jsonb_build_object('phone',case when i.id is not null then p_phone else null end);
end; $$;

create function private.inspect_registration_challenge(p_challenge_id uuid,p_browser_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c private.sms_challenges%rowtype;i private.support_registration_invitations%rowtype;
begin
  if session_user<>'hub_app_server' then raise exception 'Server required.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub_sms_start',0));
  select * into c from private.sms_challenges where id=p_challenge_id and browser_hash=p_browser_hash
    and consumed_at is null and expires_at>now() and attempts<5 and registration_invitation_id is not null for update;
  if c.id is null then return null; end if;
  update private.sms_challenges set attempts=attempts+1 where id=c.id;
  select * into i from private.support_registration_invitations where id=c.registration_invitation_id and claimed_at is null and revoked_at is null and expires_at>now() for update;
  if i.id is null or not private.registration_issuer_current(i) then return null; end if;
  return jsonb_build_object('phone',i.phone_e164,'providerId',c.provider_id);
end; $$;

-- Called only after the application server receives an accepted Telnyx response
-- for the exact challenge and phone. It is not exposed as a browser RPC.
create function private.complete_support_registration(p_challenge_id uuid,p_browser_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c private.sms_challenges%rowtype;i private.support_registration_invitations%rowtype;uid uuid:=gen_random_uuid();version uuid;
begin
  if session_user<>'hub_app_server' then raise exception 'Server required.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub_sms_start',0));
  select * into c from private.sms_challenges where id=p_challenge_id and browser_hash=p_browser_hash and consumed_at is null
    and expires_at>now() and attempts between 1 and 5 and provider_id is not null and registration_invitation_id is not null for update;
  if c.id is null then raise exception 'Challenge unavailable.' using errcode='28000'; end if;
  select * into i from private.support_registration_invitations where id=c.registration_invitation_id and claimed_at is null and revoked_at is null and expires_at>now() for update;
  if i.id is null or not private.registration_issuer_current(i) then raise exception 'Invitation unavailable.' using errcode='28000'; end if;
  perform private.registration_available(i.identity,i.phone_e164);
  -- No password, email credential, Supabase verification, tenant membership or
  -- staff permission is created. The Auth row is only a durable foreign-key identity.
  insert into auth.users(id,aud,role,raw_user_meta_data,raw_app_meta_data,created_at,updated_at,is_anonymous)
    values(uid,'authenticated','authenticated',jsonb_build_object('display_name',i.display_name),jsonb_build_object('provider','caremetric_sms','providers','[]'::jsonb),now(),now(),false);
  insert into private.sms_identities(user_id,phone_e164,verified_at) values(uid,i.phone_e164,now()) returning identity_version into version;
  update private.support_registration_invitations set claimed_at=now(),claimed_user_id=uid where id=i.id;
  update private.sms_challenges set consumed_at=now() where id=c.id;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata) values(uid,'support.registration.claim','support_registration_invitation',i.id,
    jsonb_build_object('issuingActorId',i.actor_id,'accessGranted',false));
  return jsonb_build_object('userId',uid,'identityVersion',version);
end; $$;

create function private.registration_review_view(r private.support_registration_reviews) returns jsonb
language sql stable set search_path='' as $$ select jsonb_build_object('reviewId',r.id,'proofDigest',r.proof_digest,'expiresAt',r.expires_at,
  'identity',r.identity,'phone',r.phone_e164,'displayName',r.display_name,'tenantName',r.tenant_name); $$;
create function private.registration_invitation_view(i private.support_registration_invitations) returns jsonb
language sql stable set search_path='' as $$ select jsonb_build_object('invitationId',i.id,'identity',i.identity,'displayName',i.display_name,
  'tenantName',i.tenant_name,'phoneEnding',right(i.phone_e164,4),'expiresAt',i.expires_at,'hubUserId',i.claimed_user_id,
  'state',case when i.claimed_at is not null then 'claimed' when i.revoked_at is not null then 'revoked' when i.expires_at<=now() then 'expired' else 'pending' end); $$;

create function hub.prepare_support_registration(p_actor_id uuid,p_session_id uuid,p_identity jsonb,p_phone text,p_display_name text,p_tenant_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.support_registration_reviews%rowtype;
begin
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  perform private.registration_available(p_identity,p_phone);
  if length(btrim(p_display_name)) not between 1 and 120 or length(btrim(p_tenant_name)) not between 2 and 180
    or p_display_name is null or p_tenant_name is null then raise exception 'Invalid account name.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('support_registration_review:'||p_session_id,0));
  if (select count(*) from private.support_registration_reviews where session_id=p_session_id and created_at>now()-interval '15 minutes')>=30 then
    raise exception 'Too many registration reviews.' using errcode='42501'; end if;
  insert into private.support_registration_reviews(actor_id,session_id,identity,phone_e164,display_name,tenant_name,proof_digest)
    values(p_actor_id,p_session_id,p_identity,p_phone,btrim(p_display_name),btrim(p_tenant_name),encode(extensions.gen_random_bytes(32),'hex')) returning * into r;
  return private.registration_review_view(r);
end; $$;

create function hub.inspect_support_registration(p_actor_id uuid,p_session_id uuid,p_review_id uuid,p_proof_digest text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r private.support_registration_reviews%rowtype;
begin
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  select * into r from private.support_registration_reviews where id=p_review_id and actor_id=p_actor_id and session_id=p_session_id
    and proof_digest=p_proof_digest and expires_at>now();
  if r.id is null then raise exception 'Registration review expired.' using errcode='40001'; end if;
  return private.registration_review_view(r);
end; $$;

create function hub.issue_support_registration(p_actor_id uuid,p_session_id uuid,p_review_id uuid,p_proof_digest text,p_request_id uuid,p_token_hash text,p_identity jsonb,p_reviewed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.support_registration_reviews%rowtype;i private.support_registration_invitations%rowtype;
begin
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  if p_reviewed is distinct from true or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_request_id is null then raise exception 'Explicit review required.' using errcode='22023'; end if;
  select * into r from private.support_registration_reviews where id=p_review_id and actor_id=p_actor_id and session_id=p_session_id
    and proof_digest=p_proof_digest for update;
  if r.id is null or r.identity is distinct from p_identity then raise exception 'Review changed.' using errcode='40001'; end if;
  select * into i from private.support_registration_invitations where id=p_request_id;
  if i.id is not null then
    if i.review_id<>r.id or i.token_hash<>p_token_hash or i.revoked_at is not null or i.expires_at<=now() then raise exception 'Invitation changed.' using errcode='40001'; end if;
    return private.registration_invitation_view(i);
  end if;
  if r.expires_at<=now() then raise exception 'Review expired.' using errcode='40001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub_sms_start',0));
  perform private.registration_available(p_identity,r.phone_e164);
  -- Expired, unclaimed invitations may be replaced. A claimed identity can never be replaced here.
  update private.support_registration_invitations set revoked_at=now() where revoked_at is null and claimed_at is null and expires_at<=now()
    and (phone_e164=r.phone_e164 or (identity->>'product'=p_identity->>'product' and identity->>'sourceUserId'=p_identity->>'sourceUserId'));
  insert into private.support_registration_invitations(id,review_id,actor_id,session_id,identity,phone_e164,display_name,tenant_name,token_hash)
    values(p_request_id,r.id,p_actor_id,p_session_id,p_identity,r.phone_e164,r.display_name,r.tenant_name,p_token_hash) returning * into i;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata) values(p_actor_id,'support.registration.invite','support_registration_invitation',i.id,
    jsonb_build_object('product',p_identity->>'product','reviewId',r.id,'accessGranted',false));
  return private.registration_invitation_view(i);
end; $$;

create function hub.list_support_registrations(p_actor_id uuid,p_session_id uuid,p_offset integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  if p_offset is null or p_offset<0 or p_offset>10000 then raise exception 'Invalid offset.' using errcode='22023'; end if;
  return jsonb_build_object('rows',coalesce((select jsonb_agg(page.result) from
    (select private.registration_invitation_view(i) as result from private.support_registration_invitations i order by created_at desc,id limit 20 offset p_offset)page),'[]'::jsonb),
    'offset',p_offset,'total',(select count(*) from private.support_registration_invitations));
end; $$;
create function hub.revoke_support_registration(p_actor_id uuid,p_session_id uuid,p_invitation_id uuid,p_reviewed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i private.support_registration_invitations%rowtype;
begin
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  if p_reviewed is distinct from true then raise exception 'Explicit review required.' using errcode='22023'; end if;
  select * into i from private.support_registration_invitations where id=p_invitation_id for update;
  if i.id is null or i.claimed_at is not null then raise exception 'Invitation unavailable.' using errcode='40001'; end if;
  update private.support_registration_invitations set revoked_at=coalesce(revoked_at,now()) where id=i.id returning * into i;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata) values(p_actor_id,'support.registration.revoke','support_registration_invitation',i.id,'{}');
  return private.registration_invitation_view(i);
end; $$;

revoke all on function private.validate_registration_identity(jsonb),private.registration_available(jsonb,text),private.registration_issuer_current(private.support_registration_invitations),
  private.registration_review_view(private.support_registration_reviews),private.registration_invitation_view(private.support_registration_invitations),
  private.start_registration_challenge(text,text,text,text,uuid),private.inspect_registration_challenge(uuid,text),private.complete_support_registration(uuid,text),
  hub.prepare_support_registration(uuid,uuid,jsonb,text,text,text),hub.inspect_support_registration(uuid,uuid,uuid,text),
  hub.issue_support_registration(uuid,uuid,uuid,text,uuid,text,jsonb,boolean),hub.list_support_registrations(uuid,uuid,integer),
  hub.revoke_support_registration(uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.start_registration_challenge(text,text,text,text,uuid),private.inspect_registration_challenge(uuid,text),private.complete_support_registration(uuid,text),
  hub.prepare_support_registration(uuid,uuid,jsonb,text,text,text),hub.inspect_support_registration(uuid,uuid,uuid,text),
  hub.issue_support_registration(uuid,uuid,uuid,text,uuid,text,jsonb,boolean),hub.list_support_registrations(uuid,uuid,integer),
  hub.revoke_support_registration(uuid,uuid,uuid,boolean) to hub_app_server;

-- 20260911203050_carebase_customer_onboarding.sql
-- Extend the reviewed customer pairing path to nonemployee CareBase accounts.
-- Reuse CareBase's canonical issuer, native UUID hashes and tenant lock namespace.
-- This performs no provisioning at migration time and writes no learning evidence.
create function private.support_native_issuer(p_product text) returns text
language sql immutable strict set search_path='' as $$
  select case when p_product='carebase' then 'https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1'
    else 'urn:caremetric:support:'||p_product end;
$$;
revoke all on function private.support_native_issuer(text) from public,anon,authenticated,service_role,hub_app_server;

create or replace function private.validate_support_identity(p_identity jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare product text:=p_identity->>'product'; uid text:=p_identity->>'sourceUserId'; aid text:=p_identity->>'sourceAccountId';
  kind text; relation text; pattern text;
begin
  if p_identity is null or jsonb_typeof(p_identity)<>'object' or
    (select array_agg(key order by key) from jsonb_object_keys(p_identity) key)
      is distinct from array['accountKind','product','relationship','revision','sourceAccountId','sourceUserId']::text[]
    or product not in ('carebase','breathe','caremetric-emr','caremetric-go','pennsync','intel') or product is null
    or p_identity->>'revision' is null or (p_identity->>'revision') !~ '^[0-9a-f]{64}$' then
    raise exception 'Verified native identity required.' using errcode='22023'; end if;
  kind:=case product when 'intel' then 'individual' when 'pennsync' then 'agency' else 'organization' end;
  relation:=case product when 'intel' then 'individual_owner' when 'pennsync' then 'agency_member' else 'organization_member' end;
  pattern:=case when product in ('intel','pennsync') then '^[0-9a-f]{24}$' else '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' end;
  if p_identity->>'accountKind' is distinct from kind or p_identity->>'relationship' is distinct from relation
    or aid is null or aid !~ pattern or uid is null
    or (product='breathe' and uid !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')
    or (product<>'breathe' and uid !~ pattern) or (product='intel' and uid<>aid) then
    raise exception 'Verified native account relationship required.' using errcode='22023'; end if;
  return product;
end; $$;

create or replace function private.support_onboarding_state(p_identity jsonb,p_hub_user uuid,p_hub_tenant uuid) returns text
language sql stable security definer set search_path='' as $$
  select private.support_identity_hash(jsonb_build_object(
    'hubIdentity',(select jsonb_build_object('version',i.identity_version,'verifiedAt',i.verified_at,'revokedAt',i.revoked_at) from private.sms_identities i where i.user_id=p_hub_user),
    'hubProfile',(select to_jsonb(p) from hub.profiles p where p.id=p_hub_user),
    'issuer',(select to_jsonb(f) from private.federation_issuers f where f.issuer=private.support_native_issuer(p_identity->>'product')),
    'principal',(select to_jsonb(p) from private.federated_principals p join private.federation_issuers f on f.id=p.issuer_id
      where f.issuer=private.support_native_issuer(p_identity->>'product') and p.external_subject_hash=private.support_identity_hash(p_identity->>'sourceUserId')),
    'binding',(select to_jsonb(t) from private.federated_tenants t join private.federation_issuers f on f.id=t.issuer_id
      where f.issuer=private.support_native_issuer(p_identity->>'product') and t.external_tenant_hash=private.support_identity_hash(p_identity->>'sourceAccountId')),
    'tenant',(select to_jsonb(t) from hub.tenants t where t.id=p_hub_tenant),
    'product',(select to_jsonb(p) from hub.products p where p.slug=case p_identity->>'product' when 'intel' then 'caremetric-intel' else p_identity->>'product' end),
    'access',(select to_jsonb(t) from hub.tenant_products t join hub.products p on p.id=t.product_id where t.tenant_id=p_hub_tenant and p.slug=case p_identity->>'product' when 'intel' then 'caremetric-intel' else p_identity->>'product' end),
    'member',(select to_jsonb(m) from hub.tenant_product_memberships m join hub.products p on p.id=m.product_id where m.tenant_id=p_hub_tenant and m.user_id=p_hub_user and p.slug=case p_identity->>'product' when 'intel' then 'caremetric-intel' else p_identity->>'product' end),
    'intake',(select to_jsonb(s) from private.case_intake_settings s join hub.products p on p.id=s.product_id where s.tenant_id=p_hub_tenant and p.slug=case p_identity->>'product' when 'intel' then 'caremetric-intel' else p_identity->>'product' end)
  )::text);
$$;

create or replace function hub.prepare_support_onboarding(p_actor_id uuid,p_session_id uuid,p_identity jsonb,p_hub_user_id uuid,p_tenant_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare product text; pid uuid; tenant uuid; display_name text; intent private.support_onboarding_intents%rowtype;
begin
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  product:=private.validate_support_identity(p_identity);
  display_name:=private.support_onboarding_user(p_hub_user_id);
  if p_tenant_name is null or char_length(btrim(p_tenant_name)) not between 2 and 180 then
    raise exception 'Review the customer account name.' using errcode='22023'; end if;
  select id into pid from hub.products where slug=case product when 'intel' then 'caremetric-intel' else product end and status<>'retired' and support_enabled;
  if pid is null then raise exception 'Eligible support product required.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('support-preview:'||p_session_id::text,0));
  if (select count(*) from private.support_onboarding_intents where session_id=p_session_id and created_at>now()-interval '15 minutes')>=30 then
    raise exception 'Too many account previews. Try later.' using errcode='42501'; end if;
  select t.hub_tenant_id into tenant from private.federated_tenants t join private.federation_issuers f on f.id=t.issuer_id
    where f.issuer=private.support_native_issuer(product) and t.external_tenant_hash=private.support_identity_hash(p_identity->>'sourceAccountId');
  tenant:=coalesce(tenant,gen_random_uuid());
  if exists(select 1 from private.case_intake_settings where tenant_id=tenant and product_id=pid and enabled) then
    raise exception 'Disable and review existing intake before linking another customer.' using errcode='42501'; end if;
  -- Display the canonical name for an existing account; never rename it implicitly.
  select coalesce((select name from hub.tenants where id=tenant),btrim(p_tenant_name)) into p_tenant_name;
  insert into private.support_onboarding_intents(actor_id,session_id,product_id,identity,hub_user_id,hub_tenant_id,tenant_name,hub_display_name,state_digest,proof_digest)
    values(p_actor_id,p_session_id,pid,p_identity,p_hub_user_id,tenant,p_tenant_name,display_name,
      private.support_onboarding_state(p_identity,p_hub_user_id,tenant),private.support_identity_hash(gen_random_uuid()::text)) returning * into intent;
  return private.support_onboarding_view(intent);
end; $$;

create or replace function hub.apply_support_onboarding(p_actor_id uuid,p_session_id uuid,p_intent_id uuid,p_proof_digest text,p_request_id uuid,p_identity jsonb,p_reviewed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.support_onboarding_intents%rowtype; product text; fid uuid; principal private.federated_principals%rowtype;
  prior_tenant uuid; member hub.tenant_product_memberships%rowtype; v_result jsonb;
begin
  perform hub.inspect_support_onboarding(p_actor_id,p_session_id,p_intent_id,p_proof_digest,p_request_id);
  if p_reviewed is distinct from true then raise exception 'Review the exact account pairing.' using errcode='22023'; end if;
  product:=private.validate_support_identity(p_identity);
  select * into intent from private.support_onboarding_intents where id=p_intent_id for update;
  if intent.identity is distinct from p_identity then raise exception 'Native account relationship changed.' using errcode='40001'; end if;
  -- Serialize both mappings, including concurrent previews by different admins.
  perform pg_advisory_xact_lock(hashtextextended('support-issuer:'||product,0));
  perform pg_advisory_xact_lock(hashtextextended('support-request:'||p_request_id::text,0));
  if exists(select 1 from private.support_onboarding_intents where request_id=p_request_id and id<>p_intent_id)
    or (intent.request_id is not null and intent.request_id<>p_request_id)
    or (intent.applied_at is null and intent.expires_at<=now()) then raise exception 'Preview changed or expired.' using errcode='40001'; end if;
  -- Serialize with the existing receipt setup before taking tenant/product row
  -- locks. Customer pairing never creates an employee binding or learning receipt.
  if product='carebase' then
    perform pg_advisory_xact_lock(hashtextextended('carebase-tenant:'||(p_identity->>'sourceAccountId'),0));
    perform pg_advisory_xact_lock(hashtextextended('carebase-principal:'||(p_identity->>'sourceUserId'),0));
  end if;
  -- Lock existing mutable rows as well as serializing this provisioning path.
  perform 1 from auth.users where id=intent.hub_user_id for share;
  perform 1 from hub.profiles where id=intent.hub_user_id for share;
  perform 1 from private.sms_identities where user_id=intent.hub_user_id for share;
  perform 1 from hub.products where id=intent.product_id and status<>'retired' and support_enabled for update;
  if not found then raise exception 'Eligible support product required.' using errcode='42501'; end if;
  perform 1 from hub.tenants where id=intent.hub_tenant_id for update;
  perform 1 from hub.tenant_products where tenant_id=intent.hub_tenant_id and product_id=intent.product_id for update;
  perform 1 from hub.tenant_product_memberships where tenant_id=intent.hub_tenant_id and product_id=intent.product_id and user_id=intent.hub_user_id for update;
  perform 1 from private.case_intake_settings where tenant_id=intent.hub_tenant_id and product_id=intent.product_id for update;
  if intent.applied_at is null and intent.state_digest<>private.support_onboarding_state(p_identity,intent.hub_user_id,intent.hub_tenant_id) then
    raise exception 'Customer access changed. Preview again.' using errcode='40001'; end if;
  if exists(select 1 from private.case_intake_settings where tenant_id=intent.hub_tenant_id and product_id=intent.product_id and enabled) then
    raise exception 'Existing intake requires separate review.' using errcode='42501'; end if;
  if product='carebase' then
    if intent.applied_at is null then
      insert into private.federation_issuers(product_id,issuer,audience,jwks_url,enabled,verification_method)
        values(intent.product_id,private.support_native_issuer(product),'authenticated',
          'https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1/.well-known/jwks.json',false,'oidc') on conflict(issuer) do nothing;
    end if;
    select id into fid from private.federation_issuers where issuer=private.support_native_issuer(product) and product_id=intent.product_id
      and audience='authenticated' and verification_method='oidc'
      and jwks_url='https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1/.well-known/jwks.json' for update;
  else
  if intent.applied_at is null then
    insert into private.federation_issuers(product_id,issuer,audience,jwks_url,enabled,verification_method)
      values(intent.product_id,private.support_native_issuer(product),'support.operator_review',null,false,'operator_review') on conflict(issuer) do nothing;
  end if;
  select id into fid from private.federation_issuers where issuer=private.support_native_issuer(product) and product_id=intent.product_id
    and audience='support.operator_review' and verification_method='operator_review' and not enabled and jwks_url is null for update;
  end if;
  if fid is null then raise exception 'Review the existing source configuration.' using errcode='40001'; end if;
  select * into principal from private.federated_principals where issuer_id=fid and external_subject_hash=private.support_identity_hash(p_identity->>'sourceUserId') for update;
  if found and (principal.hub_user_id<>intent.hub_user_id or principal.revoked_at is not null) then
    raise exception 'Existing principal cannot be repointed or restored.' using errcode='40001'; end if;
  select hub_tenant_id into prior_tenant from private.federated_tenants where issuer_id=fid and external_tenant_hash=private.support_identity_hash(p_identity->>'sourceAccountId') for update;
  if prior_tenant is not null and prior_tenant<>intent.hub_tenant_id then raise exception 'Existing account cannot be repointed.' using errcode='40001'; end if;
  if intent.applied_at is not null and (principal.hub_user_id is null or prior_tenant is null) then
    raise exception 'Existing identity binding requires review.' using errcode='40001'; end if;
  if intent.applied_at is null then
    if prior_tenant is null then
      insert into hub.tenants(id,slug,name) values(intent.hub_tenant_id,case when product='carebase' then 'carebase-'||(p_identity->>'sourceAccountId') else 'support-'||intent.hub_tenant_id::text end,intent.tenant_name);
      insert into private.federated_tenants(issuer_id,external_tenant_hash,hub_tenant_id) values(fid,private.support_identity_hash(p_identity->>'sourceAccountId'),intent.hub_tenant_id);
      insert into hub.tenant_products(tenant_id,product_id) values(intent.hub_tenant_id,intent.product_id);
    end if;
    insert into private.federated_principals(issuer_id,external_subject_hash,hub_user_id) values(fid,private.support_identity_hash(p_identity->>'sourceUserId'),intent.hub_user_id) on conflict do nothing;
    insert into hub.tenant_product_memberships(tenant_id,product_id,user_id,role,case_scope,can_manage_members)
      values(intent.hub_tenant_id,intent.product_id,intent.hub_user_id,'customer','own',false) on conflict do nothing;
    insert into private.case_intake_settings(tenant_id,product_id,enabled) values(intent.hub_tenant_id,intent.product_id,false) on conflict do nothing;
  end if;
  select * into member from hub.tenant_product_memberships where tenant_id=intent.hub_tenant_id and product_id=intent.product_id and user_id=intent.hub_user_id;
  if member.user_id is null or member.status<>'active' or member.revoked_at is not null or member.role<>'customer' or member.case_scope<>'own' or member.can_manage_members
    or not exists(select 1 from hub.tenants t join hub.tenant_products p on p.tenant_id=t.id where t.id=intent.hub_tenant_id and p.product_id=intent.product_id and t.status='active' and p.status='active') then
    raise exception 'Existing access requires separate review.' using errcode='42501'; end if;
  perform private.support_onboarding_user(intent.hub_user_id);
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  if intent.applied_at is not null then return intent.result||jsonb_build_object('replayed',true); end if;
  v_result:=jsonb_build_object('intentId',intent.id,'hubTenantId',intent.hub_tenant_id,'hubUserId',intent.hub_user_id,'product',product,
    'replayed',false,'access','customer','caseScope','own','intakeEnabled',false);
  update private.support_onboarding_intents set applied_at=now(),request_id=p_request_id,result=v_result where id=intent.id;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,tenant_id,product_id,metadata)
    values(p_actor_id,'support.customer.link','tenant',intent.hub_tenant_id,intent.hub_tenant_id,intent.product_id,
      jsonb_build_object('intentId',intent.id,'requestId',p_request_id,'hubUserId',intent.hub_user_id,'reviewed',true,'intakeEnabled',false));
  return v_result;
end; $$;

-- 20260911203100_support_customer_registration_contract.sql
-- Registration is separate from granting app access. Preserve every reviewed
-- feature already present, including course controls released independently.
do $migration$
declare signature text; contract jsonb;
begin
  if to_regprocedure('hub.get_backend_contract()') is null then raise exception 'Apply the Hub foundation first' using errcode='55000';end if;
  contract:=hub.get_backend_contract();
  if (contract @> '{"api_version":4,"features":["app.sms.v1","support.customer-onboarding.v1","learning.receipts.v1"]}'::jsonb) is not true
    or to_regclass('private.support_registration_reviews') is null or to_regclass('private.support_registration_invitations') is null then
    raise exception 'Apply the reviewed registration foundation first' using errcode='55000';end if;
  foreach signature in array array[
    'private.validate_registration_identity(jsonb)','private.registration_available(jsonb,text)',
    'private.support_native_issuer(text)',
    'private.registration_issuer_current(private.support_registration_invitations)',
    'private.start_registration_challenge(text,text,text,text,uuid)',
    'private.inspect_registration_challenge(uuid,text)','private.complete_support_registration(uuid,text)',
    'hub.prepare_support_registration(uuid,uuid,jsonb,text,text,text)',
    'hub.inspect_support_registration(uuid,uuid,uuid,text)',
    'hub.issue_support_registration(uuid,uuid,uuid,text,uuid,text,jsonb,boolean)',
    'hub.list_support_registrations(uuid,uuid,integer)','hub.revoke_support_registration(uuid,uuid,uuid,boolean)'
  ] loop
    if to_regprocedure(signature) is null then raise exception 'Missing reviewed registration function %',signature using errcode='55000';end if;
    if has_function_privilege('anon',signature,'execute') or has_function_privilege('authenticated',signature,'execute') then
      raise exception 'Registration functions must remain private: %',signature using errcode='55000';end if;
  end loop;
  if private.support_native_issuer('carebase') is distinct from 'https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1'
    or private.validate_support_identity('{"product":"carebase","sourceUserId":"11111111-1111-4111-8111-111111111111","sourceAccountId":"22222222-2222-4222-8222-222222222222","accountKind":"organization","relationship":"organization_member","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb) is distinct from 'carebase' then
    raise exception 'Apply canonical CareBase support pairing first' using errcode='55000';end if;
  if not (contract->'features' @> '["support.customer-registration.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.customer-registration.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select '||quote_literal(contract::text)||'::jsonb');
end;
$migration$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- 20260911204842_billing_checkout_backend_contract.sql
-- Hub compatibility is separate from native/Stripe configuration and readiness.
do $$
declare signature text;
begin
  if (hub.get_backend_contract() @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1","learning.draft-editing.v1","billing.portal.v1","support.customer-onboarding.v1","learning.structure.v1"]}'::jsonb) is not true then
    raise exception 'Apply the complete structure and portal foundation before checkout declaration' using errcode='55000';
  end if;
  if to_regclass('private.billing_checkout_intents') is null or to_regtype('private.billing_checkout_action') is null then
    raise exception 'Apply the reviewed checkout intent table and action enum first' using errcode='55000';
  end if;
  foreach signature in array array[
    'hub.authorize_app_command()', 'private.current_app_session_verified()', 'private.billing_portal_actor()',
    'private.billing_checkout_intent_view(private.billing_checkout_intents)', 'private.require_billing_checkout_intent(uuid)',
    'private.resume_billing_checkout(uuid)', 'private.reserve_billing_checkout(jsonb)', 'private.dispatch_billing_checkout_preview(uuid)',
    'private.remember_billing_checkout_preview(uuid,jsonb)', 'private.claim_billing_checkout(uuid,text,boolean)',
    'private.record_billing_checkout_result(uuid,uuid,jsonb)', 'private.claim_billing_checkout_recovery(uuid)', 'private.remember_billing_checkout_recovery(uuid,uuid,jsonb)', 'private.discard_billing_checkout(uuid)'
  ] loop
    if to_regprocedure(signature) is null then
      raise exception 'Missing reviewed checkout function %',signature using errcode='55000';
    end if;
  end loop;
  if enum_range(null::private.billing_checkout_action)::text[] is distinct from array['billing.checkout.create','billing.checkout.recover']::text[]
    or not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid='private.billing_checkout_intents'::regclass
      and a.attname='action' and not a.attisdropped and a.attnotnull and a.atttypid='private.billing_checkout_action'::regtype)
    or position('''billing.checkout.create''' in pg_catalog.pg_get_functiondef('private.reserve_billing_checkout(jsonb)'::regprocedure))=0
    or position('''packageId''' in pg_catalog.pg_get_functiondef('private.reserve_billing_checkout(jsonb)'::regprocedure))=0 then
    raise exception 'Apply the closed checkout action and native plan contract first' using errcode='55000';
  end if;
  if position('Recovery cannot create checkout.' in pg_catalog.pg_get_functiondef('private.claim_billing_checkout(uuid,text,boolean)'::regprocedure))=0
    or position('p_check_only is not true' in pg_catalog.pg_get_functiondef('private.claim_billing_checkout(uuid,text,boolean)'::regprocedure))=0 then
    raise exception 'Apply the GET-only recovery boundary first' using errcode='55000';
  end if;
  if not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid='private.billing_checkout_intents'::regclass
      and a.attname='observation_id' and not a.attisdropped and a.atttypid='uuid'::regtype)
    or not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid='private.billing_checkout_intents'::regclass
      and a.attname='provider_session_id' and not a.attisdropped and a.atttypid='text'::regtype)
    or position('p_observation_id' in pg_catalog.pg_get_functiondef('private.record_billing_checkout_result(uuid,uuid,jsonb)'::regprocedure))=0
    or position('v_intent.observation_id is distinct from p_observation_id' in pg_catalog.pg_get_functiondef('private.record_billing_checkout_result(uuid,uuid,jsonb)'::regprocedure))=0
    or position('v_intent.provider_session_id' in pg_catalog.pg_get_functiondef('private.record_billing_checkout_result(uuid,uuid,jsonb)'::regprocedure))=0 then
    raise exception 'Apply the checkout observation and immutable session boundary first' using errcode='55000';
  end if;
end;
$$;
-- Preserve earlier independently reviewed features in a captured public literal.
do $declaration$
declare contract jsonb:=hub.get_backend_contract(); features jsonb;
begin
  features:=contract->'features';
  if jsonb_typeof(features) is distinct from 'array' or jsonb_array_length(features)>99
    or exists(select 1 from jsonb_array_elements(features) value where jsonb_typeof(value)<>'string')
    or (select count(*)<>count(distinct value) from jsonb_array_elements(features) value) then
    raise exception 'Invalid prior checkout feature declaration' using errcode='55000';
  end if;
  if not(features ? 'billing.checkout.v1') then features:=features||'["billing.checkout.v1"]'::jsonb; end if;
  contract:=jsonb_build_object('api_version',4,'features',features);
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    format('select %L::jsonb',contract::text));
end;
$declaration$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- 20260911210552_governed_course_creation_intents.sql
-- CareBase owns the atomic course/version writer. Hub stores reviewed requests
-- and a private catalog identity; this never publishes or grants learning access.
create table private.course_creation_intents (
  request_id uuid primary key, actor_id uuid not null references hub.profiles(id),
  session_id uuid not null references private.sms_sessions(id), course_id uuid not null, version_id uuid not null,
  request jsonb not null check(octet_length(request::text)<=32768), created_at timestamptz not null default now(),
  command_id uuid unique, preview jsonb check(octet_length(preview::text)<=8192), preview_digest text,
  dispatched_at timestamptz, discarded_at timestamptz, result jsonb check(octet_length(result::text)<=8192),
  registration jsonb, check((preview is null)=(command_id is null)), check((preview is null)=(preview_digest is null)),
  check((result is null)=(registration is null)), check(discarded_at is null or dispatched_at is null)
);
create index course_creation_actor_idx on private.course_creation_intents(actor_id,created_at desc);
create index course_creation_session_idx on private.course_creation_intents(session_id);
create index course_creation_course_idx on private.course_creation_intents(course_id);
create index course_creation_version_idx on private.course_creation_intents(version_id);
alter table private.course_creation_intents enable row level security;
revoke all on private.course_creation_intents from public,anon,authenticated,service_role,hub_app_server;

create function private.course_creation_actor() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor jsonb;
begin
  if session_user<>'hub_app_server' then raise exception 'Application server required.' using errcode='42501'; end if;
  actor:=hub.authorize_app_command(); perform private.require_learning_editor(); return actor;
end; $$;
create function private.course_creation_view(p_intent private.course_creation_intents) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('request',p_intent.request,'preview',p_intent.preview,'result',p_intent.result,
    'registration',p_intent.registration,'createdAt',p_intent.created_at,'dispatchedAt',p_intent.dispatched_at);
$$;
create function private.require_course_creation(p_request_id uuid) returns private.course_creation_intents
language plpgsql security definer set search_path='' as $$
declare actor jsonb; intent private.course_creation_intents%rowtype;
begin
  actor:=private.course_creation_actor();
  select * into intent from private.course_creation_intents where request_id=p_request_id for update;
  if not found or intent.actor_id is distinct from (actor->>'user_id')::uuid or intent.discarded_at is not null then
    raise exception 'Course creation request unavailable.' using errcode='42501'; end if;
  return intent;
end; $$;
create function private.get_course_creation(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin return private.course_creation_view(private.require_course_creation(p_request_id)); end; $$;
create function private.list_course_creations(p_offset integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; rows jsonb; more boolean;
begin
  actor:=private.course_creation_actor();
  if p_offset is null or p_offset not between 0 and 10000 then raise exception 'Invalid saved request page.' using errcode='22023'; end if;
  select coalesce(jsonb_agg(i.value order by i.completed,i.created_at desc,i.request_id),'[]'::jsonb) into rows
    from (select private.course_creation_view(t) as value,t.result is not null as completed,t.created_at,t.request_id from private.course_creation_intents t
      where actor_id=(actor->>'user_id')::uuid and discarded_at is null order by (result is not null),created_at desc,request_id limit 20 offset p_offset) i;
  select exists(select 1 from private.course_creation_intents where actor_id=(actor->>'user_id')::uuid and discarded_at is null offset p_offset+20) into more;
  return jsonb_build_object('rows',rows,'nextOffset',case when more and p_offset+20<=10000 then p_offset+20 else null end);
end; $$;
create function private.reserve_course_creation(p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; intent private.course_creation_intents%rowtype; rid uuid; cid uuid; vid uuid;
begin
  actor:=private.course_creation_actor();
  if p_request is null or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>32768
    or not(p_request ?& array['operation','requestId','action','courseId','parameters','reason'])
    or p_request-array['operation','requestId','action','courseId','parameters','reason']<>'{}'::jsonb
    or p_request->>'operation' is distinct from 'preview' or p_request->>'action' is distinct from 'learning.createCourse'
    or jsonb_typeof(p_request->'parameters') is distinct from 'object'
    or not(p_request->'parameters' ?& array['versionId','course','version'])
    or (p_request->'parameters')-array['versionId','course','version']<>'{}'::jsonb
    or jsonb_typeof(p_request->'parameters'->'course') is distinct from 'object'
    or jsonb_typeof(p_request->'parameters'->'version') is distinct from 'object'
    or jsonb_typeof(p_request->'reason') is distinct from 'string' or length(p_request->>'reason') not between 10 and 500 then
    raise exception 'Invalid course creation request.' using errcode='22023'; end if;
  rid:=(p_request->>'requestId')::uuid; cid:=(p_request->>'courseId')::uuid; vid:=(p_request->'parameters'->>'versionId')::uuid;
  if rid is null or cid is null or vid is null or cid=vid then raise exception 'Distinct course and version identities required.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub-course-create-request:'||rid::text,0));
  select * into intent from private.course_creation_intents where request_id=rid for update;
  if found then
    if intent.request is distinct from p_request or intent.actor_id is distinct from (actor->>'user_id')::uuid
      or intent.session_id is distinct from (actor->>'session_id')::uuid or intent.discarded_at is not null then
      raise exception 'Original course creation request required.' using errcode='40001'; end if;
    return private.course_creation_view(intent);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hub-course-create:'||cid::text,0));
  if exists(select 1 from private.course_creation_intents where (course_id=cid or version_id=vid) and actor_id<>(actor->>'user_id')::uuid)
    or exists(select 1 from hub.course_links where lower(penntrain_course_id)=cid::text) then
    raise exception 'Course identity is already registered.' using errcode='40001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub-course-create-actor:'||(actor->>'user_id'),0));
  if (select count(*) from private.course_creation_intents where actor_id=(actor->>'user_id')::uuid and created_at>now()-interval '15 minutes')>=20 then
    raise exception 'Too many new course reviews. Resume a saved request.' using errcode='42501'; end if;
  insert into private.course_creation_intents(request_id,actor_id,session_id,course_id,version_id,request)
    values(rid,(actor->>'user_id')::uuid,(actor->>'session_id')::uuid,cid,vid,p_request) returning * into intent;
  return private.course_creation_view(intent);
end; $$;
create function private.remember_course_creation(p_request_id uuid,p_preview jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.course_creation_intents%rowtype; actor jsonb; expiry timestamptz; cid uuid;
begin
  intent:=private.require_course_creation(p_request_id); actor:=private.course_creation_actor();
  if intent.session_id is distinct from (actor->>'session_id')::uuid then raise exception 'Original preview session required.' using errcode='42501'; end if;
  if p_preview is null or jsonb_typeof(p_preview)<>'object' or octet_length(p_preview::text)>8192
    or not(p_preview ?& array['commandId','courseId','action','reason','previewDigest','expiresAt','before','after'])
    or p_preview-array['commandId','courseId','action','reason','previewDigest','expiresAt','before','after']<>'{}'::jsonb
    or p_preview->>'action' is distinct from 'learning.createCourse' or (p_preview->>'courseId')::uuid is distinct from intent.course_id
    or p_preview->>'reason' is distinct from intent.request->>'reason'
    or coalesce(p_preview->>'previewDigest','') !~ '^[0-9a-f]{64}$'
    or p_preview->'before' is distinct from jsonb_build_object('courseId',intent.course_id,'versionId',intent.version_id,'exists',false)
    or p_preview->'after' is distinct from jsonb_build_object('courseId',intent.course_id,'versionId',intent.version_id,
      'courseStatus','draft','status','draft','versionNumber',1,'title',intent.request->'parameters'->'version'->>'title',
      'currentVersionId',null,'aiReviewRequired',false,'contentStandard','comprehensive') then
    raise exception 'Native course preview mismatch.' using errcode='22023'; end if;
  expiry:=(p_preview->>'expiresAt')::timestamptz;cid:=(p_preview->>'commandId')::uuid;
  if cid is null or expiry is null or not isfinite(expiry) or expiry>clock_timestamp()+interval '305 seconds' then
    raise exception 'Invalid creation preview lifetime.' using errcode='22023'; end if;
  if intent.preview is not null then
    if intent.preview is distinct from p_preview then raise exception 'Creation preview changed.' using errcode='40001'; end if;
    return private.course_creation_view(intent);
  end if;
  if expiry<=clock_timestamp() then raise exception 'Creation preview expired.' using errcode='40001'; end if;
  update private.course_creation_intents set preview=p_preview,command_id=cid,preview_digest=p_preview->>'previewDigest'
    where request_id=p_request_id returning * into intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(intent.actor_id,'learning.creation.preview','native_course',intent.course_id,jsonb_build_object('request_id',p_request_id,'command_id',cid));
  return private.course_creation_view(intent);
end; $$;
create function private.dispatch_course_creation(p_command_id uuid,p_expected_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rid uuid; intent private.course_creation_intents%rowtype; actor jsonb;
begin
  actor:=private.course_creation_actor();
  select request_id into rid from private.course_creation_intents where command_id=p_command_id;
  intent:=private.require_course_creation(rid);
  if intent.session_id is distinct from (actor->>'session_id')::uuid then raise exception 'Recover this request in the new session.' using errcode='42501'; end if;
  if intent.preview_digest is distinct from p_expected_digest then raise exception 'Creation preview changed.' using errcode='40001'; end if;
  if intent.dispatched_at is null and (intent.preview->>'expiresAt')::timestamptz<=clock_timestamp() then
    raise exception 'Creation preview expired.' using errcode='40001'; end if;
  update private.course_creation_intents set dispatched_at=coalesce(dispatched_at,now()) where request_id=rid returning * into intent;
  return private.course_creation_view(intent);
end; $$;
create function private.register_course_creation(p_request_id uuid,p_result jsonb,p_payload text,p_source_revision text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.course_creation_intents%rowtype; item uuid; doc jsonb; snapshot jsonb; v_registration jsonb; applied timestamptz;
begin
  intent:=private.require_course_creation(p_request_id);
  if intent.preview is null or p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>8192
    or not(p_result ?& array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed','courseStatus','currentVersionId','contentStandard','sourceRevision'])
    or p_result-array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed','courseStatus','currentVersionId','contentStandard','sourceRevision']<>'{}'::jsonb
    or (p_result->>'commandId')::uuid is distinct from intent.command_id or (p_result->>'courseId')::uuid is distinct from intent.course_id
    or (p_result->>'versionId')::uuid is distinct from intent.version_id or p_result->>'action' is distinct from 'learning.createCourse'
    or p_result->'versionNumber' is distinct from '1'::jsonb or p_result->>'status' is distinct from 'draft'
    or p_result->>'courseStatus' is distinct from 'draft' or p_result->'currentVersionId' is distinct from 'null'::jsonb
    or p_result->>'contentStandard' is distinct from 'comprehensive' or jsonb_typeof(p_result->'replayed') is distinct from 'boolean'
    or coalesce(p_result->>'sourceRevision','') !~ '^[0-9a-f]{64}$' then
    raise exception 'Native creation receipt mismatch.' using errcode='22023'; end if;
  applied:=(p_result->>'appliedAt')::timestamptz;
  if applied is null or not isfinite(applied) then raise exception 'Invalid creation receipt time.' using errcode='22023'; end if;
  if intent.result is not null then
    if intent.result-'replayed' is distinct from p_result-'replayed' then raise exception 'Native creation receipt changed.' using errcode='40001'; end if;
    return private.course_creation_view(intent);
  end if;
  doc:=private.validate_governed_learning_source(p_payload,p_source_revision);
  if (doc->>'sourceCourseId')::uuid is distinct from intent.course_id or (doc->>'sourceVersionId')::uuid is distinct from intent.version_id then
    raise exception 'Native creation source identity changed.' using errcode='40001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub-course-create:'||intent.course_id::text,0));
  item:=md5('penntrain-course-item:'||intent.course_id::text)::uuid;
  if exists(select 1 from hub.course_links where lower(penntrain_course_id)=intent.course_id::text)
    or exists(select 1 from hub.content_items where id=item or content_key='carebase-course.'||intent.course_id::text) then
    raise exception 'Review the existing catalog mapping; it cannot be overwritten.' using errcode='40001'; end if;
  insert into hub.content_items(id,content_key,kind,status,access_level,source_system,owner_product_id,owner_team,created_by)
    values(item,'carebase-course.'||intent.course_id::text,'course','draft','staff','penntrain',
      (select id from hub.products where slug='carebase'),'CareMetric Learning',intent.actor_id);
  insert into hub.course_links(content_item_id,penntrain_course_id,source_version,launch_path,duration_minutes)
    values(item,intent.course_id::text,intent.version_id::text,'/app/courses/'||intent.course_id::text,
      (intent.request->'parameters'->'course'->>'estimatedDurationMinutes')::integer);
  if p_source_revision=p_result->>'sourceRevision' then
    -- Only the exact new draft is preserved automatically. Current edits need a
    -- separate review through the existing source-preservation interface.
    if doc->>'publicationState'<>'draft' or doc->>'sourceVersionState'<>'draft' or doc->'sourceVersionNumber'<>'1'::jsonb
      or doc->'blocks'<>'[]'::jsonb or doc->'credits'<>'[]'::jsonb or doc->'packages'<>'[]'::jsonb or doc->'provider'<>'null'::jsonb
      or doc->'version'->>'contentStandard'<>'comprehensive' then
      raise exception 'Unexpected initial course material.' using errcode='40001'; end if;
    snapshot:=hub.stage_learning_source(p_payload,p_source_revision,null);
  end if;
  v_registration:=jsonb_build_object('itemId',item,'snapshotId',snapshot->'snapshotId','sourceRevision',snapshot->'sourceRevision');
  update private.course_creation_intents set result=p_result,registration=v_registration where request_id=p_request_id returning * into intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(intent.actor_id,'learning.creation.registered','content_item',item,
      jsonb_build_object('request_id',p_request_id,'command_id',intent.command_id,'course_id',intent.course_id,'version_id',intent.version_id,'initial_snapshot',snapshot is not null));
  return private.course_creation_view(intent);
end; $$;
create function private.discard_course_creation(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.course_creation_intents%rowtype;
begin
  intent:=private.require_course_creation(p_request_id);
  if intent.dispatched_at is not null or intent.result is not null then raise exception 'Recover a dispatched creation request.' using errcode='40001'; end if;
  update private.course_creation_intents set discarded_at=now() where request_id=p_request_id;
  return jsonb_build_object('discarded',true);
end; $$;
revoke all on function private.course_creation_actor(),private.course_creation_view(private.course_creation_intents),private.require_course_creation(uuid),
  private.get_course_creation(uuid),private.list_course_creations(integer),private.reserve_course_creation(jsonb),private.remember_course_creation(uuid,jsonb),
  private.dispatch_course_creation(uuid,text),private.register_course_creation(uuid,jsonb,text,text),private.discard_course_creation(uuid)
  from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.get_course_creation(uuid),private.list_course_creations(integer),private.reserve_course_creation(jsonb),private.remember_course_creation(uuid,jsonb),
  private.dispatch_course_creation(uuid,text),private.register_course_creation(uuid,jsonb,text,text),private.discard_course_creation(uuid) to hub_app_server;

-- 20260911212027_governed_course_creation_contract.sql
-- Add only after the private creation coordinator and governed source reader exist.
do $migration$
declare contract jsonb; features jsonb; signature text;
begin
  if to_regprocedure('hub.get_backend_contract()') is null then raise exception 'Apply the Hub foundation first' using errcode='55000'; end if;
  contract:=hub.get_backend_contract();features:=contract->'features';
  if (contract @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1","learning.draft-editing.v1","billing.portal.v1","support.customer-onboarding.v1","learning.structure.v1"]}'::jsonb) is not true
    or to_regclass('private.course_creation_intents') is null then raise exception 'Apply reviewed course creation and existing Hub features first' using errcode='55000'; end if;
  foreach signature in array array['private.course_creation_actor()','private.get_course_creation(uuid)','private.list_course_creations(integer)',
    'private.reserve_course_creation(jsonb)','private.remember_course_creation(uuid,jsonb)','private.dispatch_course_creation(uuid,text)',
    'private.register_course_creation(uuid,jsonb,text,text)','private.discard_course_creation(uuid)','hub.stage_learning_source(text,text,text)'] loop
    if to_regprocedure(signature) is null then raise exception 'Missing reviewed course creation function %',signature using errcode='55000'; end if;
  end loop;
  if has_table_privilege('authenticated','private.course_creation_intents','SELECT') or has_table_privilege('hub_app_server','private.course_creation_intents','INSERT')
    or has_function_privilege('authenticated','private.register_course_creation(uuid,jsonb,text,text)','EXECUTE')
    or not has_function_privilege('hub_app_server','private.register_course_creation(uuid,jsonb,text,text)','EXECUTE')
    or position('session_user' in pg_get_functiondef('private.course_creation_actor()'::regprocedure))=0
    or position('learning.createCourse' in pg_get_functiondef('private.remember_course_creation(uuid,jsonb)'::regprocedure))=0 then
    raise exception 'Apply private course creation authority boundaries first' using errcode='55000'; end if;
  if jsonb_typeof(features) is distinct from 'array' or jsonb_array_length(features)>99
    or exists(select 1 from jsonb_array_elements(features) f where jsonb_typeof(f)<>'string')
    or (select count(*) from jsonb_array_elements(features))<>(select count(distinct value) from jsonb_array_elements(features)) then
    raise exception 'Invalid course creation feature union' using errcode='55000'; end if;
  if not(features @> '["learning.course-creation.v1"]'::jsonb) then features:=features||'["learning.course-creation.v1"]'::jsonb; end if;
  contract:=jsonb_set(contract,'{features}',features);
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select '||quote_literal(contract::text)||'::jsonb');
end; $migration$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- 20260911215749_learning_credit_policy_intents.sql
-- Extend the existing source-bound native authoring ledger to training credit policy.
-- Course credit writes remain native; this change only validates reviewed outcomes.
create or replace function private.learning_authoring_actions() returns text[]
language sql immutable security invoker set search_path='' as $$
  select array['learning.cloneVersion','learning.publishVersion','learning.patchDraft','learning.reviewDraft','learning.editStructure','learning.editCreditPolicy']::text[];
$$;
revoke all on function private.learning_authoring_actions() from public,anon,authenticated,hub_app_server;

create or replace function hub.record_learning_authoring_result(p_command_id uuid,p_expected_digest text,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.learning_authoring_intents%rowtype; actor jsonb; source_item uuid;
begin
  actor:=hub.authorize_app_command();
  perform hub.get_learning_authoring_intent(p_command_id,p_expected_digest);
  select * into intent from private.learning_authoring_intents where command_id=p_command_id for update;
  if p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>8000
    or not(p_result ?& array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed'])
    or p_result-array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed','sourceRevision']<>'{}'::jsonb
    or ((p_result->>'action' in ('learning.patchDraft','learning.reviewDraft','learning.editStructure','learning.editCreditPolicy')) is distinct from (p_result ? 'sourceRevision'))
    or (p_result ? 'sourceRevision' and coalesce(p_result->>'sourceRevision','') !~ '^[0-9a-f]{64}$')
    or p_result->>'commandId' is distinct from intent.preview->>'commandId'
    or p_result->>'courseId' is distinct from intent.preview->>'courseId'
    or p_result->>'action' is distinct from intent.preview->>'action'
    or p_result->>'status' is distinct from intent.preview->'after'->>'status'
    or p_result->'versionNumber' is distinct from intent.preview->'after'->'versionNumber'
    or coalesce(p_result->>'versionId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or jsonb_typeof(p_result->'replayed') is distinct from 'boolean'
    or (p_result->>'action'<>'learning.cloneVersion' and p_result->>'versionId' is distinct from intent.preview->'before'->>'versionId')
    or (p_result->>'action'='learning.cloneVersion' and p_result->>'versionId' is not distinct from intent.preview->'before'->>'versionId') then
    raise exception 'The native outcome does not match the preview.' using errcode='22023';
  end if;
  if intent.result is not null then
    if intent.result-'replayed' is distinct from p_result-'replayed' then
      raise exception 'The native result changed.' using errcode='40001';
    end if;
    return intent.result||jsonb_build_object('replayed',true);
  end if;
  update private.learning_authoring_intents set result=p_result,completed_at=now() where command_id=p_command_id;
  select item_id into source_item from private.learning_source_snapshots where id=intent.snapshot_id;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values((actor->>'user_id')::uuid,'learning.authoring.applied','content_item',source_item,
      jsonb_build_object('command_id',p_command_id,'action',p_result->>'action','version_id',p_result->>'versionId'));
  return p_result;
end;
$$;
revoke all on function hub.remember_learning_authoring_preview(uuid,jsonb),hub.get_learning_authoring_intent(uuid,text),hub.record_learning_authoring_result(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function hub.remember_learning_authoring_preview(uuid,jsonb),hub.get_learning_authoring_intent(uuid,text),hub.record_learning_authoring_result(uuid,text,jsonb) to authenticated;

-- 20260911215751_learning_credit_policy_contract.sql
-- Declaration proves the reviewed Hub boundary, not native provider readiness.
do $$
declare signature text; definition text;
begin
  if (hub.get_backend_contract() @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1","learning.draft-editing.v1","billing.portal.v1","support.customer-onboarding.v1","learning.structure.v1","support.customer-registration.v1","billing.checkout.v1","learning.course-creation.v1"]}'::jsonb) is not true
    or to_regclass('private.learning_authoring_intents') is null or to_regclass('private.learning_source_snapshots') is null then
    raise exception 'Apply the reviewed creation, source and checkout foundation before credit policy' using errcode='55000';
  end if;
  foreach signature in array array['private.learning_authoring_actions()','private.require_learning_editor()',
    'hub.authorize_app_command()','hub.remember_learning_authoring_preview(uuid,jsonb)',
    'hub.get_learning_authoring_intent(uuid,text)','hub.record_learning_authoring_result(uuid,text,jsonb)',
    'private.validate_governed_learning_source(text,text)'] loop
    if to_regprocedure(signature) is null then raise exception 'Missing reviewed credit policy function: %',signature using errcode='55000'; end if;
  end loop;
  if private.learning_authoring_actions() is distinct from array['learning.cloneVersion','learning.publishVersion','learning.patchDraft','learning.reviewDraft','learning.editStructure','learning.editCreditPolicy']::text[] then
    raise exception 'Apply the closed credit policy action contract first' using errcode='55000';
  end if;
  definition:=pg_catalog.pg_get_functiondef('hub.remember_learning_authoring_preview(uuid,jsonb)'::regprocedure);
  if position('private.learning_authoring_actions()' in definition)=0 or position('private.require_learning_editor()' in definition)=0
    or position('prior.session_id' in definition)=0 or position('source.source_revision' in definition)=0 then
    raise exception 'Apply the source-bound credit policy preview guard first' using errcode='55000';
  end if;
  definition:=pg_catalog.pg_get_functiondef('hub.record_learning_authoring_result(uuid,text,jsonb)'::regprocedure);
  if position('''learning.editCreditPolicy''' in definition)=0 or position('''sourceRevision''' in definition)=0
    or position('hub.get_learning_authoring_intent(p_command_id,p_expected_digest)' in definition)=0
    or position('hub.authorize_app_command()' in definition)=0 or position('for update' in definition)=0 then
    raise exception 'Apply the credit policy result digest and current-authority guard first' using errcode='55000';
  end if;
end;
$$;
do $declaration$
declare contract jsonb:=hub.get_backend_contract(); features jsonb;
begin
  features:=contract->'features';
  if jsonb_typeof(features) is distinct from 'array' or jsonb_array_length(features)>99
    or exists(select 1 from jsonb_array_elements(features) value where jsonb_typeof(value)<>'string')
    or (select count(*)<>count(distinct value) from jsonb_array_elements(features) value) then
    raise exception 'Invalid prior credit policy feature declaration' using errcode='55000';
  end if;
  if not(features ? 'learning.credit-policy.v1') then features:=features||'["learning.credit-policy.v1"]'::jsonb; end if;
  contract:=jsonb_build_object('api_version',4,'features',features);
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    format('select %L::jsonb',contract::text));
end;
$declaration$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- Applied migration: 20260911220747_hub_docstudio_runtime.sql
-- Hub-owned replacement for the removed EMR DocStudio feature. No historical
-- drafts, approvals, credentials, render results or native identities are seeded.
create table private.docstudio_projects (
 id uuid primary key, content_key text not null unique,
 revision integer not null check(revision between 1 and 100),
 status text not null check(status in ('draft','in_review','approved')),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index docstudio_projects_creator_idx on private.docstudio_projects(created_by);
create index docstudio_projects_page_idx on private.docstudio_projects(updated_at desc,id desc);
create table private.docstudio_revisions (
 project_id uuid not null references private.docstudio_projects(id), revision integer not null,
 body jsonb not null check(jsonb_typeof(body)='object' and octet_length(body::text)<=1000000),
 body_hash text not null check(body_hash ~ '^[0-9a-f]{64}$'),
 author_id uuid not null references auth.users(id), created_at timestamptz not null default now(),
 primary key(project_id,revision)
);
create index docstudio_revision_author_idx on private.docstudio_revisions(author_id);
create table private.docstudio_approvals (
 project_id uuid not null, revision integer not null, reviewer_id uuid not null references auth.users(id),
 body_hash text not null, approved_at timestamptz not null default now(),
 primary key(project_id,revision), foreign key(project_id,revision) references private.docstudio_revisions(project_id,revision)
);
create index docstudio_approval_reviewer_idx on private.docstudio_approvals(reviewer_id);
create table private.docstudio_intents (
 id uuid primary key, actor_id uuid not null references auth.users(id), request_id uuid not null,
 command jsonb not null, expires_at timestamptz not null default now()+interval '10 minutes',
 receipt jsonb, created_at timestamptz not null default now(), unique(actor_id,request_id)
);
create table private.docstudio_assets (
 id uuid primary key, project_id uuid not null references private.docstudio_projects(id),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'), byte_length integer not null check(byte_length between 1 and 33554432),
 media_type text not null check(media_type in ('image/png','image/jpeg','audio/mpeg','audio/wav')),
 created_at timestamptz not null default now(), verified_at timestamptz, cleanup_at timestamptz, transfer_expires_at timestamptz
);
create index docstudio_assets_project_idx on private.docstudio_assets(project_id);
create index docstudio_assets_cleanup_idx on private.docstudio_assets(created_at) where cleanup_at is null;
create table private.docstudio_workers (
 id uuid primary key, source_revision text not null check(source_revision ~ '^[0-9a-f]{40}$'), seen_at timestamptz not null default now()
);
create table private.docstudio_jobs (
 id uuid primary key, project_id uuid not null, revision integer not null,
 actor_id uuid not null references auth.users(id), session_id uuid not null references private.sms_sessions(id),
 status text not null check(status in ('queued','running','completed','failed','cancelled')),
 manifest jsonb not null, attempts integer not null default 0 check(attempts between 0 and 3),
 progress integer not null default 0 check(progress between 0 and 100),
 worker_id uuid references private.docstudio_workers(id), lease_hash text, lease_expires_at timestamptz,
 media_info jsonb, created_at timestamptz not null default now(), finished_at timestamptz,
 foreign key(project_id,revision) references private.docstudio_revisions(project_id,revision)
);
create index docstudio_jobs_project_idx on private.docstudio_jobs(project_id,created_at);
create index docstudio_jobs_actor_idx on private.docstudio_jobs(actor_id);
create index docstudio_jobs_session_idx on private.docstudio_jobs(session_id);
create index docstudio_jobs_worker_idx on private.docstudio_jobs(worker_id);
create index docstudio_jobs_queue_idx on private.docstudio_jobs(created_at,id);
create unique index docstudio_jobs_active_idx on private.docstudio_jobs(project_id) where status in ('queued','running');
create table private.docstudio_outputs (
 job_id uuid not null references private.docstudio_jobs(id), attempt integer not null check(attempt between 1 and 3),
 part text not null check(part in ('primary','captions','transcript')),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'), byte_length integer not null check(byte_length between 1 and 268435456),
 media_type text not null check(media_type in ('video/mp4','text/vtt','text/plain')), verified_at timestamptz, cleanup_at timestamptz, transfer_expires_at timestamptz,
 primary key(job_id,attempt,part)
);
create table private.docstudio_cleanup_queue (
 id uuid primary key, resource jsonb not null, path text not null unique,
 created_at timestamptz not null default now(), completed_at timestamptz
);
create table private.docstudio_media_tokens (
 token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
 session_id uuid references private.sms_sessions(id), job_id uuid references private.docstudio_jobs(id),
 lease_hash text, cleanup_id uuid references private.docstudio_cleanup_queue(id), descriptor jsonb not null, expires_at timestamptz not null default now()+interval '30 seconds'
);
create index docstudio_media_session_idx on private.docstudio_media_tokens(session_id);
create index docstudio_media_job_idx on private.docstudio_media_tokens(job_id);
create index docstudio_media_expiry_idx on private.docstudio_media_tokens(expires_at);
create index docstudio_media_cleanup_idx on private.docstudio_media_tokens(cleanup_id);

do $$ declare t text; begin
 foreach t in array array['projects','revisions','approvals','intents','assets','workers','jobs','outputs','media_tokens','cleanup_queue'] loop
  execute format('alter table private.%I enable row level security','docstudio_'||t);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role,hub_app_server','docstudio_'||t);
 end loop;
end $$;
create function private.docstudio_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'DocStudio revisions and approvals are immutable' using errcode='P4090'; end $$;
create trigger docstudio_revision_immutable before update or delete on private.docstudio_revisions for each row execute function private.docstudio_immutable();
create trigger docstudio_approval_immutable before update or delete on private.docstudio_approvals for each row execute function private.docstudio_immutable();

create function private.docstudio_scope(p_body jsonb,p_key text) returns uuid
language sql stable security definer set search_path='' as $$
 select private.require_publication_scope(jsonb_build_object('placements',coalesce((select jsonb_agg(jsonb_build_object('product_slug',value)) from jsonb_array_elements_text(p_body->'products')),'[]'::jsonb)),p_key)
$$;
create function private.docstudio_validate(p_body jsonb) returns void
language plpgsql stable security definer set search_path='' as $$
declare v_scene jsonb; v_asset jsonb; n integer:=0; duration integer:=0; total bigint:=0;
begin
 if jsonb_typeof(p_body) is distinct from 'object' or octet_length(p_body::text)>1000000
  or coalesce(p_body->>'kind','') not in ('article','video') or coalesce(p_body->>'accessLevel','') not in ('public','customer','staff')
  or coalesce(p_body->>'locale','')<>'en-US' or length(coalesce(p_body->>'title','')) not between 2 and 180
  or length(coalesce(p_body->>'summary','')) not between 1 and 500
  or jsonb_typeof(p_body->'products') is distinct from 'array' or jsonb_array_length(p_body->'products') not between 1 and 6
  or jsonb_typeof(p_body->'assets') is distinct from 'array' or jsonb_array_length(p_body->'assets')>40
  or jsonb_typeof(p_body->'scenes') is distinct from 'array' or jsonb_array_length(p_body->'scenes')>120
  or jsonb_typeof(p_body->'markdown') is distinct from 'string' or length(p_body->>'markdown')>120000
  or exists(select 1 from jsonb_object_keys(p_body) k where k not in ('kind','title','summary','locale','accessLevel','products','markdown','scenes','assets','narrationAssetId')) then
  raise exception 'Invalid DocStudio draft' using errcode='22023'; end if;
 if (select count(distinct value) from jsonb_array_elements_text(p_body->'products'))<>jsonb_array_length(p_body->'products') then raise exception 'Duplicate products' using errcode='22023'; end if;
 if p_body->>'kind'='article' then
  if length(trim(p_body->>'markdown'))=0 or jsonb_array_length(p_body->'scenes')<>0 or jsonb_array_length(p_body->'assets')<>0 or p_body ? 'narrationAssetId' then raise exception 'Invalid article' using errcode='22023'; end if;
 else
  if p_body->>'markdown'<>'' or jsonb_array_length(p_body->'scenes')=0 then raise exception 'Invalid video' using errcode='22023'; end if;
  for v_scene in select value from jsonb_array_elements(p_body->'scenes') loop
   n:=n+1;
   if (v_scene->>'order')::integer<>n or coalesce(v_scene->>'type','') not in ('intro','step','outro') or (v_scene->>'durationSeconds')::integer not between 3 and 120
    or length(coalesce(v_scene->>'title','')) not between 1 and 180 or length(coalesce(v_scene->>'narration','')) not between 1 and 4000
    or length(coalesce(v_scene->>'captionText','')) not between 1 and 2000
    or exists(select 1 from jsonb_object_keys(v_scene) k where k not in ('order','type','durationSeconds','title','narration','captionText','screenshotAssetId')) then raise exception 'Invalid scene' using errcode='22023'; end if;
   duration:=duration+(v_scene->>'durationSeconds')::integer;
   if v_scene ? 'screenshotAssetId' and not exists(select 1 from jsonb_array_elements(p_body->'assets') x where x->>'id'=v_scene->>'screenshotAssetId' and x->>'mediaType' in ('image/png','image/jpeg')) then raise exception 'Invalid image reference' using errcode='22023'; end if;
  end loop;
  if duration>3600 then raise exception 'Video too long' using errcode='22023'; end if;
  if p_body ? 'narrationAssetId' and not exists(select 1 from jsonb_array_elements(p_body->'assets') x where x->>'id'=p_body->>'narrationAssetId' and x->>'mediaType' in ('audio/mpeg','audio/wav')) then raise exception 'Invalid narration reference' using errcode='22023'; end if;
  if (select count(distinct value->>'id') from jsonb_array_elements(p_body->'assets'))<>jsonb_array_length(p_body->'assets') then raise exception 'Duplicate asset' using errcode='22023'; end if;
  for v_asset in select value from jsonb_array_elements(p_body->'assets') loop
   if coalesce(v_asset->>'sha256','') !~ '^[0-9a-f]{64}$' or coalesce(v_asset->>'mediaType','') not in ('image/png','image/jpeg','audio/mpeg','audio/wav')
    or (v_asset->>'byteLength')::integer not between 1 and 33554432 or (v_asset->>'id')::uuid is null
    or exists(select 1 from jsonb_object_keys(v_asset) k where k not in ('id','sha256','byteLength','mediaType'))
    or (not exists(select 1 from jsonb_array_elements(p_body->'scenes') scene_ref where scene_ref->>'screenshotAssetId'=v_asset->>'id') and (p_body->>'narrationAssetId') is distinct from (v_asset->>'id')) then raise exception 'Invalid source asset' using errcode='22023'; end if;
   total:=total+(v_asset->>'byteLength')::integer;
  end loop;
  if total>33554432 then raise exception 'Assets too large' using errcode='P4130'; end if;
 end if;
end $$;

create function private.docstudio_project(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p private.docstudio_projects; r private.docstudio_revisions;
begin
 select * into p from private.docstudio_projects where id=p_id;
 if p.id is null then raise exception 'Draft unavailable' using errcode='P4040'; end if;
 select * into r from private.docstudio_revisions where project_id=p_id and revision=p.revision;
 perform private.docstudio_scope(r.body,p.content_key);
 return jsonb_build_object('id',p.id,'contentKey',p.content_key,'revision',p.revision,'status',p.status,'updatedAt',p.updated_at,'kind',r.body->>'kind','title',r.body->>'title','draft',r.body,
  'approvedAt',(select approved_at from private.docstudio_approvals where project_id=p_id and revision=p.revision and p.status='approved'),
  'jobs',coalesce((select jsonb_agg(x.body order by x.created_at desc) from (select j.created_at,jsonb_build_object('id',j.id,'revision',j.revision,'status',j.status,'progress',j.progress,'attempts',j.attempts,'createdAt',j.created_at,'outputCount',(select count(*) from private.docstudio_outputs o where o.job_id=j.id and o.attempt=j.attempts and verified_at is not null)) body from private.docstudio_jobs j where j.project_id=p_id order by j.created_at desc limit 30) x),'[]'::jsonb),
  'assets',coalesce((select jsonb_agg(jsonb_build_object('id',id,'sha256',sha256,'byteLength',byte_length,'mediaType',media_type) order by created_at) from private.docstudio_assets where project_id=p_id and verified_at is not null),'[]'::jsonb));
end $$;
create function private.docstudio_can_read(p_body jsonb,p_key text) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin perform private.docstudio_scope(p_body,p_key);return true;
exception when insufficient_privilege then return false;end $$;
create function private.docstudio_read(p_cursor jsonb default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_project record; list jsonb:='[]'; last_id uuid; last_time timestamptz; more boolean:=false;
begin
 perform private.publication_import_access();
 for v_project in select p.id,p.updated_at from private.docstudio_projects p join private.docstudio_revisions r on r.project_id=p.id and r.revision=p.revision
  where private.docstudio_can_read(r.body,p.content_key)
   and (p_cursor is null or (p.updated_at,p.id)<((p_cursor->>'updatedAt')::timestamptz,(p_cursor->>'id')::uuid))
  order by p.updated_at desc,p.id desc limit 101 loop
  if jsonb_array_length(list)=100 then more:=true;exit;end if;
  list:=list||jsonb_build_array(private.docstudio_project(v_project.id)-'draft'-'assets'-'jobs'-'approvedAt'-'contentKey');
  last_id:=v_project.id;last_time:=v_project.updated_at;
 end loop;
 return jsonb_build_object('projects',list,'nextCursor',case when more then jsonb_build_object('updatedAt',last_time,'id',last_id) else null end,'products',coalesce((select jsonb_agg(jsonb_build_object('slug',slug,'name',name) order by name) from hub.products where status<>'retired' and support_enabled and private.has_staff_permission('content.write',id)),'[]'::jsonb),
  'workerReady',exists(select 1 from private.docstudio_workers where seen_at>now()-interval '30 seconds'),
  'maxVideoBytes',least(268435456,(select max_video_bytes from private.publication_import_settings where singleton)));
end $$;

create function private.docstudio_preview(p_id uuid,p_command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; p private.docstudio_projects; body jsonb; old private.docstudio_intents; op text:=p_command->>'operation';
begin
 actor:=private.docstudio_scope('{"products":[]}'::jsonb,'');
 if op not in ('create','edit','submit','approve','render','cancel') or (p_command->>'requestId')::uuid is null or (p_command->>'projectId')::uuid is null then raise exception 'Invalid command' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('docstudio-command:'||actor::text||':'||(p_command->>'requestId'),0));
 select * into old from private.docstudio_intents where actor_id=actor and request_id=(p_command->>'requestId')::uuid;
 if old.id is not null and old.command<>p_command then raise exception 'Request already used' using errcode='P4090'; end if;
 select * into p from private.docstudio_projects where id=(p_command->>'projectId')::uuid;
 if p.id is not null then
  select r.body into body from private.docstudio_revisions r where project_id=p.id and revision=p.revision;
  perform private.docstudio_scope(body,p.content_key);
 end if;
 if old.receipt is null then
  if op='create' then
   if p.id is not null or (p_command->>'expectedRevision')::integer<>0 then raise exception 'Draft already exists' using errcode='P4090'; end if;
  elsif p.id is null then raise exception 'Draft unavailable' using errcode='P4040';
  elsif p.revision<>(p_command->>'expectedRevision')::integer then raise exception 'Draft changed; review again' using errcode='P4090'; end if;
 end if;
 if op in ('create','edit') then body:=p_command->'draft'; perform private.docstudio_validate(body); perform private.docstudio_scope(body,coalesce(p.content_key,'')); end if;
 if old.id is null then
  perform pg_advisory_xact_lock(hashtextextended('docstudio-capacity',0));
  if (select count(*) from private.docstudio_intents where actor_id=actor and created_at>now()-interval '1 hour')>=300 then raise exception 'Draft operation limit reached' using errcode='P4290'; end if;
  insert into private.docstudio_intents(id,actor_id,request_id,command) values(p_id,actor,(p_command->>'requestId')::uuid,p_command) returning * into old;
 elsif old.receipt is null then update private.docstudio_intents set expires_at=now()+interval '10 minutes' where id=old.id returning * into old;
 end if;
 return jsonb_build_object('id',old.id,'requestId',old.request_id,'operation',op,'projectId',p_command->'projectId','expectedRevision',p_command->'expectedRevision','title',body->>'title','products',body->'products','expiresAt',old.expires_at);
end $$;

create function private.docstudio_apply(p_id uuid,p_request uuid,p_review boolean,p_phi boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i private.docstudio_intents; p private.docstudio_projects; body jsonb; next_body jsonb; actor uuid; op text; project uuid; rev integer; job uuid; manifest jsonb; v_receipt jsonb;
begin
 actor:=private.docstudio_scope('{"products":[]}'::jsonb,'');
 select * into i from private.docstudio_intents where id=p_id and actor_id=actor for update;
 if i.id is null or i.request_id<>p_request or p_review is distinct from true then raise exception 'Review required' using errcode='22023'; end if;
 op:=i.command->>'operation'; project:=(i.command->>'projectId')::uuid;
 perform pg_advisory_xact_lock(hashtextextended('docstudio-project:'||project::text,0));
 select * into p from private.docstudio_projects where id=project for update;
 if p.id is not null then select r.body into body from private.docstudio_revisions r where project_id=project and revision=p.revision; perform private.docstudio_scope(body,p.content_key); end if;
 if op in ('create','edit') then next_body:=i.command->'draft'; perform private.docstudio_scope(next_body,coalesce(p.content_key,'')); end if;
 if op='approve' and p_phi is distinct from true then raise exception 'Source safety review required' using errcode='22023'; end if;
 if i.receipt is not null then return i.receipt; end if;
 if i.expires_at<=now() then raise exception 'Review expired' using errcode='P4090'; end if;
 if op='create' then
  if p.id is not null or (i.command->>'expectedRevision')::integer<>0 then raise exception 'Draft already exists' using errcode='P4090'; end if;
  perform pg_advisory_xact_lock(hashtextextended('docstudio-project-capacity',0));
  if (select count(*) from private.docstudio_projects)>=10000 or (select count(*) from private.docstudio_projects where created_by=actor and created_at>now()-interval '1 day')>=100 then raise exception 'Draft capacity reached' using errcode='P4290'; end if;
  rev:=1;
  insert into private.docstudio_projects(id,content_key,revision,status,created_by) values(project,'hub-guide.'||replace(project::text,'-',''),rev,'draft',actor) returning * into p;
 else
  if p.id is null or p.revision<>(i.command->>'expectedRevision')::integer then raise exception 'Draft changed; review again' using errcode='P4090'; end if;
  rev:=p.revision;
 end if;
 if op in ('create','edit') then
  perform private.docstudio_validate(next_body);
  if op='edit' then
   if rev>=100 or next_body->>'kind'<>body->>'kind' then raise exception 'Draft revision or kind conflict' using errcode='P4090'; end if;
   rev:=rev+1;
  end if;
  if exists(select 1 from jsonb_array_elements(next_body->'assets') a where not exists(select 1 from private.docstudio_assets x where x.id=(a->>'id')::uuid and x.project_id=project and x.verified_at is not null and x.cleanup_at is null and x.sha256=a->>'sha256' and x.byte_length=(a->>'byteLength')::integer and x.media_type=a->>'mediaType')) then raise exception 'Asset bytes not verified' using errcode='P4090'; end if;
  insert into private.docstudio_revisions(project_id,revision,body,body_hash,author_id) values(project,rev,next_body,encode(extensions.digest(next_body::text,'sha256'),'hex'),actor);
  update private.docstudio_projects set revision=rev,status='draft',updated_at=now() where id=project;
  update private.docstudio_jobs set status='cancelled',finished_at=now(),lease_hash=null where project_id=project and status in ('queued','running');
 elsif op='submit' then
  if p.status<>'draft' then raise exception 'Draft is not awaiting submission' using errcode='P4090'; end if;
  update private.docstudio_projects set status='in_review',updated_at=now() where id=project;
 elsif op='approve' then
  if p.status<>'in_review' then raise exception 'Submit this draft for review first' using errcode='P4090'; end if;
  insert into private.docstudio_approvals(project_id,revision,reviewer_id,body_hash) select project,rev,actor,body_hash from private.docstudio_revisions where project_id=project and revision=rev;
  update private.docstudio_projects set status='approved',updated_at=now() where id=project;
 elsif op='cancel' then
  update private.docstudio_jobs set status='cancelled',finished_at=now(),lease_hash=null where project_id=project and status in ('queued','running');
  if not found then raise exception 'No active render' using errcode='P4090'; end if;
 elsif op='render' then
  if p.status<>'approved' or body->>'kind'<>'video' then raise exception 'Approve the video first' using errcode='P4090'; end if;
  if not exists(select 1 from private.docstudio_workers where seen_at>now()-interval '30 seconds') then raise exception 'Render worker unavailable' using errcode='P5030'; end if;
  if exists(select 1 from private.docstudio_jobs where project_id=project and revision=rev and status in ('queued','running','completed')) then raise exception 'This revision already has a render' using errcode='P4090'; end if;
  perform pg_advisory_xact_lock(hashtextextended('docstudio-render-capacity',0));
  if (select count(*) from private.docstudio_jobs where status in ('queued','running'))>=10 or (select count(*) from private.docstudio_jobs where created_at>now()-interval '1 day')>=100 then raise exception 'Render capacity reached' using errcode='P4290'; end if;
  job:=gen_random_uuid();
  manifest:=jsonb_build_object('protocol','caremetric.docstudio.render.v1','jobId',job,'projectId',project,'revision',rev,'engine','remotion','title',body->>'title','description',body->>'summary','scenes',body->'scenes','assets',body->'assets');
  if body ? 'narrationAssetId' then manifest:=manifest||jsonb_build_object('narrationAssetId',body->'narrationAssetId'); end if;
  insert into private.docstudio_jobs(id,project_id,revision,actor_id,session_id,status,manifest) values(job,project,rev,actor,(auth.jwt()->>'sms_session_id')::uuid,'queued',manifest);
 end if;
 v_receipt:=jsonb_build_object('intentId',i.id,'requestId',p_request,'projectId',project,'revision',rev,'operation',op,'jobId',job,'appliedAt',now());
 update private.docstudio_intents set receipt=v_receipt where id=i.id;
 return v_receipt;
end $$;

create function private.docstudio_stage_asset(p_project uuid,p_asset jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a private.docstudio_assets;
begin
 perform private.docstudio_project(p_project);
 perform pg_advisory_xact_lock(hashtextextended('docstudio-assets:'||p_project::text,0));
 if exists(select 1 from private.docstudio_cleanup_queue where resource->>'assetId'=p_asset->>'id') then raise exception 'Asset identity was retired' using errcode='P4090';end if;
 select * into a from private.docstudio_assets where id=(p_asset->>'id')::uuid;
 if a.id is not null then
  if a.cleanup_at is not null or a.project_id<>p_project or a.sha256<>p_asset->>'sha256' or a.byte_length<>(p_asset->>'byteLength')::integer or a.media_type<>p_asset->>'mediaType' then raise exception 'Asset identity already used' using errcode='P4090'; end if;
 else
  if (select count(*) from private.docstudio_assets where project_id=p_project)>=100 or coalesce((select sum(byte_length) from private.docstudio_assets where project_id=p_project),0)+(p_asset->>'byteLength')::integer>134217728 then raise exception 'Draft asset capacity reached' using errcode='P4290'; end if;
  insert into private.docstudio_assets(id,project_id,sha256,byte_length,media_type) values((p_asset->>'id')::uuid,p_project,p_asset->>'sha256',(p_asset->>'byteLength')::integer,p_asset->>'mediaType');
 end if;
 return p_asset;
end $$;

create function private.docstudio_prepare_output(p_job uuid,p_lease text,p_part text,p_sha text,p_bytes integer,p_type text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.docstudio_jobs; o private.docstudio_outputs; maximum integer;
begin
 j:=private.docstudio_lease(p_job,p_lease);
 maximum:=case when p_part='primary' then least(268435456,(select max_video_bytes from private.publication_import_settings where singleton)) else 1048576 end;
 if p_bytes not between 1 and maximum or p_type is distinct from (case p_part when 'primary' then 'video/mp4' when 'captions' then 'text/vtt' when 'transcript' then 'text/plain' end) or p_sha !~ '^[0-9a-f]{64}$' then raise exception 'Invalid output declaration' using errcode='22023'; end if;
 select * into o from private.docstudio_outputs where job_id=p_job and attempt=j.attempts and part=p_part;
 if o.job_id is not null then
  if o.sha256<>p_sha or o.byte_length<>p_bytes or o.media_type<>p_type then raise exception 'Immutable output conflict' using errcode='P4090'; end if;
 else insert into private.docstudio_outputs(job_id,attempt,part,sha256,byte_length,media_type) values(p_job,j.attempts,p_part,p_sha,p_bytes,p_type);
 end if;
 return jsonb_build_object('verified',o.verified_at is not null);
end $$;

create function private.docstudio_media_descriptor(p_resource jsonb,p_operation text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.docstudio_jobs; a private.docstudio_assets; o private.docstudio_outputs; p jsonb; path text; media text; sha text; bytes integer;
begin
 if p_operation not in ('upload','download') then raise exception 'Invalid media operation' using errcode='22023'; end if;
 if p_resource ? 'leaseHash' then
  j:=private.docstudio_lease((p_resource->>'jobId')::uuid,p_resource->>'leaseHash');
 elsif p_resource ? 'jobId' then
  select * into j from private.docstudio_jobs where id=(p_resource->>'jobId')::uuid;
  p:=private.docstudio_project(j.project_id);
  if p_operation<>'download' or j.status<>'completed' or j.revision<>(p->>'revision')::integer or p->>'status'<>'approved' then raise exception 'Output is not available for this revision' using errcode='P4090'; end if;
 else p:=private.docstudio_project((p_resource->>'projectId')::uuid);
 end if;
 if p_resource ? 'assetId' then
  if p_operation='upload' then perform pg_advisory_xact_lock(hashtextextended('docstudio-project:'||coalesce(j.project_id,(p->>'id')::uuid)::text,0));end if;
  select * into a from private.docstudio_assets where id=(p_resource->>'assetId')::uuid;
  if a.id is null or a.cleanup_at is not null or a.project_id<>coalesce(j.project_id,(p->>'id')::uuid) or (p_operation='download' and a.verified_at is null) then raise exception 'Asset unavailable' using errcode='P4040'; end if;
  if j.id is not null and (p_operation<>'download' or not exists(select 1 from jsonb_array_elements(j.manifest->'assets') x where x->>'id'=a.id::text and x->>'sha256'=a.sha256 and (x->>'byteLength')::integer=a.byte_length and x->>'mediaType'=a.media_type)) then raise exception 'Asset is not in the leased revision' using errcode='42501'; end if;
  -- Covers the 110-second Edge upload and 120-second server transfer deadlines.
  if p_operation='upload' then update private.docstudio_assets set transfer_expires_at=now()+interval '3 minutes' where id=a.id;end if;
  path:='assets/'||a.project_id::text||'/'||a.id::text; media:=a.media_type; sha:=a.sha256; bytes:=a.byte_length;
 else
  select * into o from private.docstudio_outputs where job_id=j.id and attempt=j.attempts and part=p_resource->>'part';
  if o.job_id is null or o.cleanup_at is not null or (p_operation='download' and o.verified_at is null) then raise exception 'Output unavailable' using errcode='P4040'; end if;
  if p_operation='upload' then update private.docstudio_outputs set transfer_expires_at=now()+interval '3 minutes' where job_id=j.id and attempt=j.attempts and part=o.part;end if;
  path:='renders/'||j.id::text||'/'||j.attempts::text||'/'||o.part; media:=o.media_type; sha:=o.sha256; bytes:=o.byte_length;
 end if;
 return jsonb_build_object('path',path,'operation',p_operation,'contentType',media,'sha256',sha,'byteLength',bytes,'maxBytes',bytes,'range',null);
end $$;
create function private.docstudio_issue_media(p_hash text,p_resource jsonb,p_operation text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare descriptor jsonb; sid uuid;
begin
 descriptor:=private.docstudio_media_descriptor(p_resource,p_operation);
 if not (p_resource ? 'leaseHash') then sid:=(auth.jwt()->>'sms_session_id')::uuid; end if;
 delete from private.docstudio_media_tokens where token_hash in (select token_hash from private.docstudio_media_tokens where expires_at<=now() order by expires_at limit 1000);
 insert into private.docstudio_media_tokens(token_hash,session_id,job_id,lease_hash,descriptor) values(p_hash,sid,(p_resource->>'jobId')::uuid,p_resource->>'leaseHash',jsonb_build_object('resource',p_resource,'operation',p_operation));
 return descriptor;
end $$;
create function private.docstudio_consume_media(p_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.docstudio_media_tokens; actor uuid; q private.docstudio_cleanup_queue;
begin
 delete from private.docstudio_media_tokens where token_hash=p_hash and expires_at>now() returning * into t;
 if t.token_hash is null then raise exception 'Media authorization expired' using errcode='28000'; end if;
 if t.cleanup_id is not null then
  select * into q from private.docstudio_cleanup_queue where id=t.cleanup_id and completed_at is null;
  if q.id is null then raise exception 'Cleanup already completed' using errcode='P4090'; end if;
  return jsonb_build_object('operation','cleanup','paths',jsonb_build_array(q.path));
 end if;
 if t.session_id is not null then
  select user_id into actor from private.sms_sessions where id=t.session_id;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','sms_session_id',t.session_id)::text,true);
 end if;
 return private.docstudio_media_descriptor(t.descriptor->'resource',t.descriptor->>'operation');
end $$;
create function private.docstudio_verify_media(p_resource jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare descriptor jsonb; j private.docstudio_jobs;
begin
 descriptor:=private.docstudio_media_descriptor(p_resource,'upload');
 if p_resource ? 'assetId' then update private.docstudio_assets set verified_at=coalesce(verified_at,now()) where id=(p_resource->>'assetId')::uuid;
 else
  j:=private.docstudio_lease((p_resource->>'jobId')::uuid,p_resource->>'leaseHash');
  update private.docstudio_outputs set verified_at=coalesce(verified_at,now()) where job_id=j.id and attempt=j.attempts and part=p_resource->>'part';
 end if;
 return jsonb_build_object('verified',true,'sha256',descriptor->>'sha256','byteLength',descriptor->'byteLength');
end $$;

create function private.docstudio_export_context(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p jsonb; body jsonb; artifact jsonb; job private.docstudio_jobs; approved timestamptz; manifest jsonb;
begin
 p:=private.docstudio_project(p_id); body:=p->'draft';
 if p->>'status'<>'approved' then raise exception 'Approve this revision first' using errcode='P4090'; end if;
 select approved_at into approved from private.docstudio_approvals where project_id=p_id and revision=(p->>'revision')::integer;
 if approved is null then raise exception 'Saved approval missing' using errcode='P4090'; end if;
 if body->>'kind'='article' then artifact:=jsonb_build_object('sha256',encode(extensions.digest(convert_to(body->>'markdown','UTF8'),'sha256'),'hex'),'media_type','text/markdown','byte_length',octet_length(body->>'markdown'));
 else
  select * into job from private.docstudio_jobs where project_id=p_id and revision=(p->>'revision')::integer and status='completed' order by finished_at desc limit 1;
  if job.id is null or (select count(*) from private.docstudio_outputs where job_id=job.id and attempt=job.attempts and verified_at is not null)<>3 then raise exception 'Complete the real render first' using errcode='P4090'; end if;
  select jsonb_build_object('sha256',sha256,'media_type',media_type,'byte_length',byte_length,'duration_ms',job.media_info->'durationMs') into artifact from private.docstudio_outputs where job_id=job.id and attempt=job.attempts and part='primary';
  artifact:=artifact||jsonb_build_object('captions_sha256',(select sha256 from private.docstudio_outputs where job_id=job.id and attempt=job.attempts and part='captions'),'transcript_sha256',(select sha256 from private.docstudio_outputs where job_id=job.id and attempt=job.attempts and part='transcript'));
 end if;
 manifest:=jsonb_build_object('schema_version','caremetric.support-hub.publication.v1','source_system','docstudio',
  'source',jsonb_build_object('content_key',p->>'contentKey','version','docstudio-v'||(p->>'revision')),
  'content',jsonb_build_object('kind',body->>'kind','title',body->>'title','summary',body->>'summary','locale',body->>'locale','access_level',body->>'accessLevel'),
  'artifact',artifact,'governance',jsonb_build_object('review_state','approved','phi_review','passed','approved_at',to_char(approved at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'policy_version','docstudio-phi-free-v1'),
  'placements',(select jsonb_agg(jsonb_build_object('product_slug',value,'audience',jsonb_build_array('all'),'route_pattern',null)) from jsonb_array_elements_text(body->'products')));
 return jsonb_build_object('projectId',p_id,'revision',p->'revision','manifest',manifest,'jobId',job.id,'markdown',case when body->>'kind'='article' then body->>'markdown' else null end);
end $$;

create table private.docstudio_exports (
 import_id uuid primary key references private.publication_imports(id), project_id uuid not null, revision integer not null,
 actor_id uuid not null references auth.users(id), request_id uuid, unique(actor_id,request_id),
 foreign key(project_id,revision) references private.docstudio_revisions(project_id,revision)
);
create index docstudio_exports_project_idx on private.docstudio_exports(project_id,revision);
alter table private.docstudio_exports enable row level security;
revoke all on private.docstudio_exports from public,anon,authenticated,service_role,hub_app_server;
create function private.docstudio_publication_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare p private.docstudio_projects; context jsonb;
begin
 -- Serialize a pending publication against edits to the same saved draft.
 select * into p from private.docstudio_projects where content_key=new.content_key for update;
 if p.id is null then return new; end if;
 if tg_op='INSERT' or (old.receipt is null and (new.plan is not null or new.receipt is not null)) then
  context:=private.docstudio_export_context(p.id);
  if new.manifest is distinct from context->'manifest' then raise exception 'DocStudio revision changed or export bytes do not match' using errcode='P4090'; end if;
 end if;
 if tg_op='INSERT' then insert into private.docstudio_exports(import_id,project_id,revision,actor_id) values(new.id,p.id,p.revision,new.actor_id); end if;
 return new;
end $$;
create trigger docstudio_publication_guard after insert or update on private.publication_imports for each row execute function private.docstudio_publication_guard();
create function private.docstudio_stage_export(p_project uuid,p_revision integer,p_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare context jsonb; e private.docstudio_exports; import uuid; actor uuid;
begin
 context:=private.docstudio_export_context(p_project); actor:=auth.uid();
 if (context->>'revision')::integer<>p_revision or p_request is null then raise exception 'Export revision changed' using errcode='P4090'; end if;
 perform pg_advisory_xact_lock(hashtextextended('docstudio-export:'||actor::text||':'||p_request::text,0));
 select * into e from private.docstudio_exports where actor_id=actor and request_id=p_request;
 if e.import_id is not null then
  if e.project_id<>p_project or e.revision<>p_revision then raise exception 'Export request already used' using errcode='P4090'; end if;
  import:=e.import_id;
 else
  import:=gen_random_uuid(); perform private.stage_publication_import(import,context->'manifest');
  update private.docstudio_exports set request_id=p_request where import_id=import;
 end if;
 return context||jsonb_build_object('importId',import);
end $$;

-- Worker authority is the dedicated server credential and current durable lease.
-- The original issuer's live SMS identity and product scopes are rechecked too.
create function private.docstudio_job_current(p_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare j private.docstudio_jobs; p private.docstudio_projects; r private.docstudio_revisions; claims text:=current_setting('request.jwt.claims',true); allowed boolean:=false;
begin
 select * into j from private.docstudio_jobs where id=p_id;
 select * into p from private.docstudio_projects where id=j.project_id;
 if j.id is null or p.revision<>j.revision or p.status<>'approved' then return false; end if;
 select * into r from private.docstudio_revisions where project_id=p.id and revision=p.revision;
 if not exists(select 1 from private.docstudio_approvals a where a.project_id=p.id and a.revision=p.revision and a.body_hash=r.body_hash) then return false; end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',j.actor_id,'role','authenticated','sms_session_id',j.session_id)::text,true);
 begin perform private.docstudio_scope(r.body,p.content_key); allowed:=true;
 exception when insufficient_privilege or invalid_authorization_specification then allowed:=false; end;
 perform set_config('request.jwt.claims',coalesce(claims,''),true);
 return allowed;
end $$;
create function private.docstudio_lease(p_id uuid,p_hash text) returns private.docstudio_jobs
language plpgsql security definer set search_path='' as $$
declare j private.docstudio_jobs;
begin
 select * into j from private.docstudio_jobs where id=p_id for update;
 if j.status is distinct from 'running' or j.lease_hash is distinct from p_hash or j.lease_expires_at<=now() or not private.docstudio_job_current(p_id) then raise exception 'Render lease unavailable' using errcode='P4090'; end if;
 return j;
end $$;
create function private.docstudio_worker(p_operation text,p_worker uuid,p_source text,p_body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.docstudio_jobs; candidate record; matches integer;
begin
 if session_user<>'hub_app_server' or p_source !~ '^[0-9a-f]{40}$' or p_worker is null or p_operation not in ('heartbeat','claim','renew','fail','complete') then raise exception 'Invalid worker operation' using errcode='42501'; end if;
 insert into private.docstudio_workers(id,source_revision) values(p_worker,p_source) on conflict(id) do update set seen_at=now(),source_revision=excluded.source_revision;
 if p_operation='heartbeat' then return jsonb_build_object('ready',true); end if;
 if p_operation='claim' then
  if coalesce(p_body->>'leaseHash','') !~ '^[0-9a-f]{64}$' then raise exception 'Invalid lease' using errcode='22023'; end if;
  for candidate in select id from private.docstudio_jobs where status='queued' or (status='running' and lease_expires_at<=now()) order by created_at for update skip locked limit 20 loop
   if not private.docstudio_job_current(candidate.id) then
    update private.docstudio_jobs set status='cancelled',finished_at=now(),lease_hash=null where id=candidate.id;
   elsif (select attempts from private.docstudio_jobs where id=candidate.id)>=3 then
    update private.docstudio_jobs set status='failed',finished_at=now(),lease_hash=null where id=candidate.id;
   else
    update private.docstudio_jobs set status='running',worker_id=p_worker,attempts=attempts+1,progress=0,lease_hash=p_body->>'leaseHash',lease_expires_at=now()+interval '45 seconds' where id=candidate.id returning * into j;
    return jsonb_build_object('job',jsonb_build_object('manifest',j.manifest,'leaseExpiresAt',j.lease_expires_at));
   end if;
  end loop;
  return jsonb_build_object('job',null);
 end if;
 if p_operation='complete' then
  select * into j from private.docstudio_jobs where id=(p_body->>'jobId')::uuid for update;
  if j.status='completed' and j.worker_id=p_worker and j.lease_hash=p_body->>'leaseHash' and j.media_info=p_body-'jobId'-'leaseHash' and private.docstudio_job_current(j.id) then return jsonb_build_object('completed',true); end if;
 end if;
 j:=private.docstudio_lease((p_body->>'jobId')::uuid,p_body->>'leaseHash');
 if j.worker_id<>p_worker then raise exception 'Wrong worker lease' using errcode='P4090'; end if;
 if p_operation='renew' then
  if (p_body->>'progress')::integer not between 0 and 98 then raise exception 'Invalid render progress' using errcode='22023'; end if;
  update private.docstudio_jobs set lease_expires_at=now()+interval '45 seconds',progress=greatest(progress,(p_body->>'progress')::integer) where id=j.id;
  return jsonb_build_object('active',true);
 elsif p_operation='fail' then
  update private.docstudio_jobs set status='failed',finished_at=now(),lease_hash=null where id=j.id;
  return jsonb_build_object('failed',true);
 end if;
 if (p_body->>'width')::integer<>1920 or (p_body->>'height')::integer<>1080 or (p_body->>'fps')::integer<>30
  or (p_body->>'durationMs')::integer<>(select sum((value->>'durationSeconds')::integer)*1000 from jsonb_array_elements(j.manifest->'scenes'))
  or (p_body->>'hasAudio')::boolean is distinct from (j.manifest ? 'narrationAssetId') or jsonb_array_length(p_body->'artifacts')<>3 then raise exception 'Invalid encoded result' using errcode='22023'; end if;
 select count(*) into matches from private.docstudio_outputs o where o.job_id=j.id and o.attempt=j.attempts and o.verified_at is not null
  and exists(select 1 from jsonb_array_elements(p_body->'artifacts') a where a->>'kind'=o.part and a->>'sha256'=o.sha256 and (a->>'byteLength')::integer=o.byte_length and a->>'mediaType'=o.media_type);
 if matches<>3 then raise exception 'All exact output bytes must be verified first' using errcode='P4090'; end if;
 update private.docstudio_jobs set status='completed',progress=100,finished_at=now(),media_info=p_body-'jobId'-'leaseHash' where id=j.id;
 return jsonb_build_object('completed',true);
end $$;

-- New private object namespace; immutable writes go through one-use server
create function private.docstudio_issue_cleanup(p_hash text) returns uuid
language plpgsql security definer set search_path='' as $$
declare q private.docstudio_cleanup_queue; a private.docstudio_assets; output_row private.docstudio_outputs; resource jsonb; path text;
begin
 perform pg_advisory_xact_lock(hashtextextended('docstudio-cleanup',0));
 delete from private.docstudio_media_tokens where token_hash in (select token_hash from private.docstudio_media_tokens where expires_at<=now() order by expires_at limit 1000);
 select * into q from private.docstudio_cleanup_queue where completed_at is null order by created_at limit 1;
 if q.id is null then
  select * into a from private.docstudio_assets x where x.created_at<now()-interval '1 day' and x.cleanup_at is null and (x.transfer_expires_at is null or x.transfer_expires_at<=now())
   and not exists(select 1 from private.docstudio_revisions r where r.project_id=x.project_id and r.body->'assets' @> jsonb_build_array(jsonb_build_object('id',x.id))) order by x.created_at limit 1;
  if a.id is not null then
   -- Use the same project lock as draft writes. Once marked, an upload or edit
   -- cannot attach these bytes while external Storage deletion is in flight.
   if not pg_try_advisory_xact_lock(hashtextextended('docstudio-project:'||a.project_id::text,0)) then return null;end if;
   if exists(select 1 from private.docstudio_assets where id=a.id and transfer_expires_at>now()) then return null;end if;
   if exists(select 1 from private.docstudio_revisions r where r.project_id=a.project_id and r.body->'assets' @> jsonb_build_array(jsonb_build_object('id',a.id))) then return null;end if;
   update private.docstudio_assets set cleanup_at=now() where id=a.id;
   resource:=jsonb_build_object('assetId',a.id,'projectId',a.project_id);path:='assets/'||a.project_id::text||'/'||a.id::text;
  else
   select o.* into output_row from private.docstudio_outputs o join private.docstudio_jobs j on j.id=o.job_id where j.created_at<now()-interval '7 days' and o.cleanup_at is null and (o.transfer_expires_at is null or o.transfer_expires_at<=now())
    and (j.status in ('failed','cancelled') or o.attempt<j.attempts) order by j.created_at,o.job_id,o.attempt,o.part limit 1;
   if output_row.job_id is null then return null;end if;
   -- Upload descriptors lock the job first; recheck the transfer and current
   -- attempt after acquiring that same lock before retiring any output key.
   perform 1 from private.docstudio_jobs where id=output_row.job_id for update skip locked;
   if not found then return null;end if;
   if not exists(select 1 from private.docstudio_outputs o join private.docstudio_jobs j on j.id=o.job_id where o.job_id=output_row.job_id and o.attempt=output_row.attempt and o.part=output_row.part and o.cleanup_at is null and (o.transfer_expires_at is null or o.transfer_expires_at<=now()) and (j.status in ('failed','cancelled') or o.attempt<j.attempts)) then return null;end if;
   update private.docstudio_outputs set cleanup_at=now() where job_id=output_row.job_id and attempt=output_row.attempt and part=output_row.part;
   resource:=jsonb_build_object('jobId',output_row.job_id,'attempt',output_row.attempt,'part',output_row.part);path:='renders/'||output_row.job_id::text||'/'||output_row.attempt::text||'/'||output_row.part;
  end if;
  insert into private.docstudio_cleanup_queue(id,resource,path) values(gen_random_uuid(),resource,path) returning * into q;
 end if;
 insert into private.docstudio_media_tokens(token_hash,cleanup_id,descriptor) values(p_hash,q.id,'{}'::jsonb);
 return q.id;
end $$;
create function private.docstudio_finish_cleanup(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare q private.docstudio_cleanup_queue;
begin
 select * into q from private.docstudio_cleanup_queue where id=p_id and completed_at is null for update;
 if q.id is null then return;end if;
 if q.resource ? 'assetId' then delete from private.docstudio_assets where id=(q.resource->>'assetId')::uuid and cleanup_at is not null;
 else delete from private.docstudio_outputs where job_id=(q.resource->>'jobId')::uuid and attempt=(q.resource->>'attempt')::integer and part=q.resource->>'part' and cleanup_at is not null;end if;
 update private.docstudio_cleanup_queue set completed_at=now() where id=q.id;
end $$;
-- New private object namespace; immutable writes go through one-use server
create function private.docstudio_worker_manifest(p_id uuid,p_lease text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.docstudio_jobs;
begin j:=private.docstudio_lease(p_id,p_lease); return j.manifest; end $$;
-- New private object namespace; immutable writes go through one-use server
-- capabilities. Browsers and workers never receive service-role credentials.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('hub-docstudio','hub-docstudio',false,268435456,array['image/png','image/jpeg','audio/mpeg','audio/wav','video/mp4','text/vtt','text/plain']);
do $$ declare fn record; begin
 for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname like 'docstudio_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,hub_app_server',fn.signature);
 end loop;
end $$;
grant execute on function private.docstudio_read(jsonb),private.docstudio_project(uuid),private.docstudio_preview(uuid,jsonb),private.docstudio_apply(uuid,uuid,boolean,boolean),
 private.docstudio_worker(text,uuid,text,jsonb),private.docstudio_stage_asset(uuid,jsonb),private.docstudio_prepare_output(uuid,text,text,text,integer,text),
 private.docstudio_issue_media(text,jsonb,text),private.docstudio_consume_media(text),private.docstudio_verify_media(jsonb),private.docstudio_export_context(uuid),private.docstudio_stage_export(uuid,integer,uuid),private.docstudio_worker_manifest(uuid,text) to hub_app_server;
grant execute on function private.docstudio_issue_cleanup(text),private.docstudio_finish_cleanup(uuid) to hub_app_server;


-- Applied migration: 20260911223938_docstudio_backend_contract.sql
-- Declare only the installed private DocStudio runtime; preserve independent
-- course, billing and operational features across coordinated releases.
do $$ declare contract jsonb:=hub.get_backend_contract(); signature text; table_name text; begin
 if not (contract @> '{"api_version":4,"features":["knowledge.publications.v1","app.sms.v1"]}'::jsonb) then raise exception 'Apply the reviewed publication and SMS foundation first' using errcode='55000'; end if;
 foreach table_name in array array['projects','revisions','approvals','intents','assets','workers','jobs','outputs','media_tokens','exports','cleanup_queue'] loop
  if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname='docstudio_'||table_name and c.relrowsecurity)
   or has_table_privilege('anon','private.docstudio_'||table_name,'select,insert,update,delete')
   or has_table_privilege('authenticated','private.docstudio_'||table_name,'select,insert,update,delete')
   or has_table_privilege('service_role','private.docstudio_'||table_name,'select,insert,update,delete')
   or has_table_privilege('hub_app_server','private.docstudio_'||table_name,'select,insert,update,delete') then raise exception 'DocStudio private table boundary missing' using errcode='55000';end if;
 end loop;
 foreach signature in array array['private.docstudio_read(jsonb)','private.docstudio_project(uuid)','private.docstudio_preview(uuid,jsonb)','private.docstudio_apply(uuid,uuid,boolean,boolean)',
  'private.docstudio_worker(text,uuid,text,jsonb)','private.docstudio_worker_manifest(uuid,text)','private.docstudio_stage_asset(uuid,jsonb)','private.docstudio_prepare_output(uuid,text,text,text,integer,text)',
  'private.docstudio_issue_media(text,jsonb,text)','private.docstudio_consume_media(text)','private.docstudio_verify_media(jsonb)','private.docstudio_stage_export(uuid,integer,uuid)',
  'private.docstudio_issue_cleanup(text)','private.docstudio_finish_cleanup(uuid)'] loop
  if to_regprocedure(signature) is null then raise exception 'Missing DocStudio operation' using errcode='55000';end if;
  if not has_function_privilege('hub_app_server',signature,'execute') or has_function_privilege('anon',signature,'execute') or has_function_privilege('authenticated',signature,'execute') or has_function_privilege('service_role',signature,'execute') then raise exception 'DocStudio operation permission boundary missing' using errcode='55000';end if;
 end loop;
 if not exists(select 1 from storage.buckets where id='hub-docstudio' and public=false) then raise exception 'Private DocStudio bucket required' using errcode='55000';end if;
 if not (contract->'features' @> '["knowledge.docstudio.v1"]'::jsonb) then contract:=jsonb_set(contract,'{features}',(contract->'features')||'["knowledge.docstudio.v1"]'::jsonb);end if;
 execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- Applied migration: 20260911232209_governed_course_distribution.sql
-- CareBase remains the course/learner authority. These records govern only
-- reviewed catalog metadata, product placements and observed availability.
create table private.learning_distribution_observations (
  course_id uuid primary key, item_id uuid not null unique references hub.content_items(id),
  managed boolean not null default false, observation_id uuid not null default gen_random_uuid(),
  attempted_at timestamptz, observed_at timestamptz, observer_verified_at timestamptz,
  native_generated_at timestamptz, publication_state text, current_version_id uuid, current_version_state text, source_revision text,
  observer_source_revision text, observer_version_id uuid, distributed_revision_id uuid references hub.content_revisions(id),
  lease_id uuid, lease_until timestamptz,
  check(publication_state is null or publication_state in ('draft','published','archived','missing')),
  check(current_version_state is null or current_version_state in ('draft','published','archived')),
  check(source_revision is null or source_revision ~ '^[0-9a-f]{64}$'),check(observer_source_revision is null or observer_source_revision ~ '^[0-9a-f]{64}$'),
  check(not managed or distributed_revision_id is not null),
  check((lease_id is null)=(lease_until is null)),check((current_version_id is null)=(current_version_state is null))
);
create index learning_distribution_observation_revision_idx on private.learning_distribution_observations(distributed_revision_id);
create table private.learning_distribution_intents (
  request_id uuid primary key, actor_id uuid not null references hub.profiles(id), session_id uuid not null references private.sms_sessions(id),
  course_id uuid not null, item_id uuid not null references hub.content_items(id), plan jsonb not null,
  source_payload text not null check(octet_length(source_payload)<=2000000), source_revision text not null check(source_revision ~ '^[0-9a-f]{64}$'),
  preview_digest text not null check(preview_digest ~ '^[0-9a-f]{64}$'), preview jsonb not null,
  created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '5 minutes',
  result jsonb, check(expires_at>created_at),check(octet_length(plan::text)<=32768),check(octet_length(preview::text)<=65536)
);
create index learning_distribution_actor_idx on private.learning_distribution_intents(actor_id,session_id,created_at desc);
create index learning_distribution_course_idx on private.learning_distribution_intents(course_id);
create index learning_distribution_item_idx on private.learning_distribution_intents(item_id);
create index learning_distribution_session_idx on private.learning_distribution_intents(session_id);
create table private.learning_distribution_revisions (
  revision_id uuid primary key references hub.content_revisions(id), item_id uuid not null references hub.content_items(id),
  request_id uuid not null unique references private.learning_distribution_intents(request_id),
  course_id uuid not null, version_id uuid not null, source_revision text not null check(source_revision ~ '^[0-9a-f]{64}$'),
  before_catalog jsonb not null, plan jsonb not null,
  actor_id uuid not null references hub.profiles(id), session_id uuid not null references private.sms_sessions(id), published_at timestamptz not null default now()
);
create index learning_distribution_revision_item_idx on private.learning_distribution_revisions(item_id);
create index learning_distribution_revision_actor_idx on private.learning_distribution_revisions(actor_id);
create index learning_distribution_revision_session_idx on private.learning_distribution_revisions(session_id);
alter table private.learning_distribution_observations enable row level security;
alter table private.learning_distribution_intents enable row level security;
alter table private.learning_distribution_revisions enable row level security;
revoke all on private.learning_distribution_observations,private.learning_distribution_intents,private.learning_distribution_revisions from public,anon,authenticated,service_role,hub_app_server;

create function private.current_distribution_actor() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb;
begin
  v_actor:=private.course_creation_actor();
  -- Existing shared authorization uses transaction time. A queued publication
  -- must also honor wall-clock session and original eight-hour assurance expiry.
  if (v_actor->>'assurance_expires_at')::timestamptz is null
    or (v_actor->>'assurance_expires_at')::timestamptz<=clock_timestamp()
    or not exists(select 1 from private.sms_sessions s where s.id=(v_actor->>'session_id')::uuid and s.user_id=(v_actor->>'user_id')::uuid
      and s.revoked_at is null and s.expires_at>clock_timestamp() and s.created_at+interval '480 minutes'>clock_timestamp()) then
    raise exception 'Current distribution session expired.' using errcode='28000';end if;
  return v_actor;
end; $$;

create function private.distribution_catalog_state(p_course_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('item',to_jsonb(i),'link',to_jsonb(l),
    'revisions',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'revisionNumber',r.revision_no,'rowHash',encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex')) order by r.revision_no,r.id) from hub.content_revisions r where r.item_id=i.id),'[]'::jsonb),
    'publications',coalesce((select jsonb_agg(to_jsonb(p) order by p.product_id,p.id) from hub.content_publications p where p.item_id=i.id),'[]'::jsonb))
  from hub.content_items i join hub.course_links l on l.content_item_id=i.id
  where lower(l.penntrain_course_id)=p_course_id::text and i.kind='course' and i.source_system='penntrain';
$$;
create function private.distribution_catalog_digest(p_course_id uuid) returns text
language sql stable security definer set search_path='' as $$
  select encode(extensions.digest(private.distribution_catalog_state(p_course_id)::text,'sha256'),'hex');
$$;
create function private.course_distribution_available(p_item_id uuid,p_revision_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  -- Opt-in only: untouched legacy catalog entries retain their existing policy.
  select not exists(select 1 from private.learning_distribution_observations where item_id=p_item_id and managed)
    or exists(select 1 from private.learning_distribution_observations o join private.learning_distribution_revisions r on r.item_id=o.item_id
      where o.item_id=p_item_id and r.revision_id=p_revision_id and o.distributed_revision_id=p_revision_id and o.managed and o.observed_at>now()-interval '15 minutes'
        and o.publication_state='published' and o.current_version_state='published'
        and o.current_version_id=r.version_id and o.source_revision=r.source_revision);
$$;
create function private.claim_course_distribution_observation(p_course_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_item uuid; v_observation uuid:=gen_random_uuid();
begin
  v_actor:=private.current_distribution_actor();
  select i.id into v_item from hub.content_items i join hub.course_links l on l.content_item_id=i.id
    where lower(l.penntrain_course_id)=p_course_id::text and i.kind='course' and i.source_system='penntrain';
  if v_item is null then raise exception 'Registered CareBase course required.' using errcode='22023'; end if;
  insert into private.learning_distribution_observations(course_id,item_id,observation_id,attempted_at)
    values(p_course_id,v_item,v_observation,clock_timestamp()) on conflict(course_id) do update
    set observation_id=excluded.observation_id,attempted_at=excluded.attempted_at,lease_id=null,lease_until=null;
  return v_observation;
end; $$;
create function private.validate_distribution_status(p_status jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare v_state text; v_version uuid; v_version_state text; v_hash text;
begin
  if p_status is null or jsonb_typeof(p_status)<>'object' or not(p_status ?& array['courseId','publicationState','currentVersionId','currentVersionState','sourceRevision'])
    or p_status-array['courseId','publicationState','currentVersionId','currentVersionState','sourceRevision']<>'{}'::jsonb
    or jsonb_typeof(p_status->'courseId')<>'string' or jsonb_typeof(p_status->'publicationState')<>'string'
    or jsonb_typeof(p_status->'currentVersionId') not in ('string','null') or jsonb_typeof(p_status->'currentVersionState') not in ('string','null')
    or jsonb_typeof(p_status->'sourceRevision') not in ('string','null')
    or (p_status->>'courseId')::uuid is null then raise exception 'Invalid source observation.' using errcode='22023'; end if;
  v_state:=p_status->>'publicationState';v_version:=(p_status->>'currentVersionId')::uuid;v_version_state:=p_status->>'currentVersionState';v_hash:=p_status->>'sourceRevision';
  if v_state is null or v_state not in ('draft','published','archived','missing') or (v_version is null)<>(v_version_state is null)
    or (v_version_state is not null and v_version_state not in ('draft','published','archived'))
    or (v_state='missing' and v_version is not null)
    or (v_hash is not null and v_hash !~ '^[0-9a-f]{64}$')
    or (v_hash is not null)<>(v_state='published' and v_version is not null and v_version_state='published') then
    raise exception 'Inconsistent source observation.' using errcode='22023'; end if;
end; $$;
create function private.record_course_distribution_observation(p_course_id uuid,p_observation_id uuid,p_generated_at timestamptz,p_status jsonb,p_machine boolean) returns void
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_row private.learning_distribution_observations%rowtype;
begin
  v_actor:=private.current_distribution_actor();perform private.validate_distribution_status(p_status);
  if (p_status->>'courseId')::uuid is distinct from p_course_id or p_machine is null or p_generated_at is null or not isfinite(p_generated_at)
    or p_generated_at<clock_timestamp()-interval '2 minutes' or p_generated_at>clock_timestamp()+interval '30 seconds' then
    raise exception 'Invalid current source observation.' using errcode='22023'; end if;
  select * into v_row from private.learning_distribution_observations where course_id=p_course_id for update;
  perform private.current_distribution_actor();
  if v_row.course_id is null or v_row.observation_id<>p_observation_id then raise exception 'Source observation was superseded.' using errcode='40001'; end if;
  update private.learning_distribution_observations set observed_at=clock_timestamp(),native_generated_at=p_generated_at,
    observer_verified_at=case when p_machine then clock_timestamp() else observer_verified_at end,
    observer_source_revision=case when p_machine then p_status->>'sourceRevision' else observer_source_revision end,
    observer_version_id=case when p_machine then (p_status->>'currentVersionId')::uuid else observer_version_id end,
    publication_state=p_status->>'publicationState',current_version_id=(p_status->>'currentVersionId')::uuid,current_version_state=p_status->>'currentVersionState',source_revision=p_status->>'sourceRevision'
    where course_id=p_course_id;
end; $$;
create function private.distribution_intent_view(p_intent private.learning_distribution_intents) returns jsonb
language sql stable set search_path='' as $$
  select p_intent.preview||jsonb_build_object('result',p_intent.result,'canCommitThisSession',
    p_intent.result is null and p_intent.expires_at>clock_timestamp() and p_intent.session_id=(private.current_distribution_actor()->>'session_id')::uuid);
$$;
create function private.distribution_availability(p_course_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_row private.learning_distribution_observations%rowtype; v_state text;
begin
  select * into v_row from private.learning_distribution_observations where course_id=p_course_id;
  v_state:=case when not found or not v_row.managed then 'legacy'
    when v_row.observed_at is null then 'unverified'
    when v_row.observed_at<=now()-interval '15 minutes' then 'stale'
    when v_row.publication_state='missing' then 'missing'
    when v_row.publication_state<>'published' or v_row.current_version_state is distinct from 'published' then 'unpublished'
    when exists(select 1 from private.learning_distribution_revisions r join hub.content_publications p on p.revision_id=r.revision_id
      where r.item_id=v_row.item_id and r.revision_id=v_row.distributed_revision_id and r.version_id=v_row.current_version_id and r.source_revision=v_row.source_revision
        and p.published_at<=now() and (p.expires_at is null or p.expires_at>now())) then 'published' else 'changed' end;
  return jsonb_build_object('managed',coalesce(v_row.managed,false),'state',v_state,'observedAt',v_row.observed_at,
    'validUntil',case when v_row.observed_at is null then null else v_row.observed_at+interval '15 minutes' end);
end; $$;
create function private.get_course_distribution_context(p_course_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_actor jsonb; v_item hub.content_items%rowtype; v_revision hub.content_revisions%rowtype; v_products jsonb; v_ids jsonb; v_requests jsonb; v_legacy boolean;
begin
  v_actor:=private.current_distribution_actor();
  select i.* into v_item from hub.content_items i join hub.course_links l on l.content_item_id=i.id
    where lower(l.penntrain_course_id)=p_course_id::text and i.kind='course' and i.source_system='penntrain';
  if not found then raise exception 'Registered CareBase course required.' using errcode='22023'; end if;
  select * into v_revision from hub.content_revisions where item_id=v_item.id order by revision_no desc,id desc limit 1;
  select coalesce(jsonb_agg(product_id order by product_id),'[]'::jsonb) into v_ids from hub.content_publications where item_id=v_item.id
    and (expires_at is null or expires_at>now());
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'slug',slug,'name',name,'eligible',status<>'retired' and support_enabled and private.has_staff_permission('content.write',id)) order by name),'[]'::jsonb)
    into v_products from hub.products where slug in ('carebase','pennsync','breathe','caremetric-emr','caremetric-go','caremetric-intel');
  select coalesce(jsonb_agg(private.distribution_intent_view(t) order by t.created_at desc,t.request_id),'[]'::jsonb) into v_requests
    from (select * from private.learning_distribution_intents where course_id=p_course_id and actor_id=(v_actor->>'user_id')::uuid
      order by created_at desc,request_id limit 20) t;
  v_legacy:=not exists(select 1 from private.course_creation_intents where registration->>'itemId'=v_item.id::text and result is not null);
  return jsonb_build_object('catalog',jsonb_build_object('itemId',v_item.id,'status',v_item.status,'accessLevel',v_item.access_level,
    'catalogDigest',private.distribution_catalog_digest(p_course_id),'metadata',case when v_revision.id is null then null else jsonb_build_object('title',v_revision.title,'summary',v_revision.summary,
      'category',nullif(btrim(v_revision.variables->>'category'),''),'durationMinutes',(select duration_minutes from hub.course_links where content_item_id=v_item.id)) end,
    'productIds',v_ids,'legacy',v_legacy,'availability',private.distribution_availability(p_course_id)),
    'products',v_products,'requests',v_requests);
end; $$;
create function private.require_course_distribution_intent(p_request_id uuid) returns private.learning_distribution_intents
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_intent private.learning_distribution_intents%rowtype;
begin
  v_actor:=private.current_distribution_actor();select * into v_intent from private.learning_distribution_intents where request_id=p_request_id for update;
  perform private.current_distribution_actor();
  if v_intent.request_id is null or v_intent.actor_id is distinct from (v_actor->>'user_id')::uuid then
    raise exception 'Distribution owner required.' using errcode='42501'; end if;
  return v_intent;
end; $$;
create function private.get_course_distribution_intent(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin return private.distribution_intent_view(private.require_course_distribution_intent(p_request_id)); end; $$;
create function private.claim_distribution_status_batch() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_lease uuid:=gen_random_uuid(); v_rows jsonb;
begin
  if session_user<>'hub_app_server' then raise exception 'Application observer required.' using errcode='42501'; end if;
  with selected as (select course_id from private.learning_distribution_observations where managed
    and (attempted_at is null or attempted_at<now()-interval '5 minutes') and (lease_until is null or lease_until<now())
    order by attempted_at nulls first,course_id for update skip locked limit 10),
  claimed as (update private.learning_distribution_observations o set observation_id=gen_random_uuid(),lease_id=v_lease,
    lease_until=clock_timestamp()+interval '90 seconds',attempted_at=clock_timestamp() from selected s where o.course_id=s.course_id returning o.course_id)
  select coalesce(jsonb_agg(course_id order by course_id),'[]'::jsonb) into v_rows from claimed;
  return jsonb_build_object('leaseId',v_lease,'courseIds',v_rows);
end; $$;
create function private.record_distribution_status_batch(p_lease_id uuid,p_generated_at timestamptz,p_items jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare v_status jsonb; v_count integer:=0; v_requested integer;
begin
  if session_user<>'hub_app_server' then raise exception 'Application observer required.' using errcode='42501'; end if;
  if p_generated_at is null or not isfinite(p_generated_at) or p_generated_at<clock_timestamp()-interval '2 minutes' or p_generated_at>clock_timestamp()+interval '30 seconds'
    or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 10
    or (select count(distinct (value->>'courseId')::uuid) from jsonb_array_elements(p_items))<>jsonb_array_length(p_items) then
    raise exception 'Invalid observer batch.' using errcode='22023'; end if;
  -- Lock the whole exact lease before changing any member; superseded batches
  -- cannot partially overwrite a more recent human or worker observation.
  perform 1 from private.learning_distribution_observations where lease_id=p_lease_id order by course_id for update;
  select count(*) into v_requested from private.learning_distribution_observations where lease_id=p_lease_id and lease_until>clock_timestamp();
  if v_requested<>jsonb_array_length(p_items) or exists(select 1 from jsonb_array_elements(p_items) j where not exists(
    select 1 from private.learning_distribution_observations o where o.lease_id=p_lease_id and o.course_id=(j.value->>'courseId')::uuid)) then
    raise exception 'Observer batch was superseded.' using errcode='40001'; end if;
  for v_status in select value from jsonb_array_elements(p_items) loop
    perform private.validate_distribution_status(v_status);
    update private.learning_distribution_observations set observed_at=clock_timestamp(),observer_verified_at=clock_timestamp(),native_generated_at=p_generated_at,
      observer_source_revision=v_status->>'sourceRevision',observer_version_id=(v_status->>'currentVersionId')::uuid,
      publication_state=v_status->>'publicationState',current_version_id=(v_status->>'currentVersionId')::uuid,current_version_state=v_status->>'currentVersionState',source_revision=v_status->>'sourceRevision',lease_id=null,lease_until=null
      where course_id=(v_status->>'courseId')::uuid and lease_id=p_lease_id;
    v_count:=v_count+1;
  end loop;
  return v_count;
end; $$;

create function private.validate_course_distribution_plan(p_plan jsonb,p_item_id uuid,p_allow_legacy boolean) returns void
language plpgsql stable security definer set search_path='' as $$
declare v_metadata jsonb; v_id uuid; v_selected uuid[]; v_removed uuid[]; v_actual_removed uuid[]; v_key text; v_text text;
begin
  perform private.current_distribution_actor();
  if p_plan is null or jsonb_typeof(p_plan)<>'object' or octet_length(p_plan::text)>32768
    or not(p_plan ?& array['courseId','versionId','sourceRevision','expectedCatalogDigest','metadata','productIds','removedProductIds','accessLevel','reason','reviewed','confirmReplacement','confirmRetirements'])
    or p_plan-array['courseId','versionId','sourceRevision','expectedCatalogDigest','metadata','productIds','removedProductIds','accessLevel','reason','reviewed','confirmReplacement','confirmRetirements']<>'{}'::jsonb
    or p_plan->'reviewed' is distinct from 'true'::jsonb or jsonb_typeof(p_plan->'confirmReplacement')<>'boolean' or jsonb_typeof(p_plan->'confirmRetirements')<>'boolean'
    or jsonb_typeof(p_plan->'sourceRevision')<>'string' or jsonb_typeof(p_plan->'expectedCatalogDigest')<>'string'
    or coalesce(p_plan->>'sourceRevision','') !~ '^[0-9a-f]{64}$' or coalesce(p_plan->>'expectedCatalogDigest','') !~ '^[0-9a-f]{64}$'
    or p_plan->>'accessLevel' not in ('public','customer','staff') or jsonb_typeof(p_plan->'accessLevel')<>'string'
    or jsonb_typeof(p_plan->'reason')<>'string' or length(p_plan->>'reason') not between 10 and 500
    or p_plan->>'reason'<>btrim(p_plan->>'reason') or p_plan->>'reason' ~ '[[:cntrl:]]'
    or jsonb_typeof(p_plan->'courseId')<>'string' or jsonb_typeof(p_plan->'versionId')<>'string'
    or coalesce(p_plan->>'courseId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_plan->>'versionId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_plan->'productIds')<>'array' or jsonb_typeof(p_plan->'removedProductIds')<>'array' then
    raise exception 'Invalid reviewed distribution plan.' using errcode='22023'; end if;
  if jsonb_array_length(p_plan->'productIds') not between 1 and 6 or jsonb_array_length(p_plan->'removedProductIds')>6
    or exists(select 1 from jsonb_array_elements((p_plan->'productIds')||(p_plan->'removedProductIds')) j
      where jsonb_typeof(j.value)<>'string' or j.value#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'Invalid product selection.' using errcode='22023'; end if;
  select array_agg(value::uuid order by value::uuid) into v_selected from jsonb_array_elements_text(p_plan->'productIds');
  select coalesce(array_agg(value::uuid order by value::uuid),array[]::uuid[]) into v_removed from jsonb_array_elements_text(p_plan->'removedProductIds');
  if cardinality(v_selected)<>(select count(distinct x) from unnest(v_selected) x)
    or cardinality(v_removed)<>(select count(distinct x) from unnest(v_removed) x) or v_selected&&v_removed
    or (cardinality(v_removed)>0 and p_plan->'confirmRetirements'<>'true'::jsonb) then
    raise exception 'Explicit distinct placement changes required.' using errcode='22023'; end if;
  v_metadata:=p_plan->'metadata';
  if jsonb_typeof(v_metadata)<>'object' or not(v_metadata ?& array['title','summary','category','durationMinutes'])
    or v_metadata-array['title','summary','category','durationMinutes']<>'{}'::jsonb then
    raise exception 'Invalid catalog metadata.' using errcode='22023'; end if;
  foreach v_key in array array['title','summary','category'] loop
    v_text:=v_metadata->>v_key;
    if (v_key<>'category' or v_text is not null) and (jsonb_typeof(v_metadata->v_key)<>'string' or v_text<>btrim(v_text) or v_text ~ '[[:cntrl:]]'
      or length(v_text)>case v_key when 'title' then 180 when 'summary' then 500 else 200 end
      or length(v_text)<case v_key when 'title' then 2 when 'summary' then 0 else 1 end) then
      raise exception 'Invalid display text.' using errcode='22023'; end if;
  end loop;
  if v_metadata->'durationMinutes'<>'null'::jsonb and (jsonb_typeof(v_metadata->'durationMinutes')<>'number'
    or v_metadata->>'durationMinutes' !~ '^[0-9]+$' or (v_metadata->>'durationMinutes')::numeric>2147483647) then
    raise exception 'Invalid display duration.' using errcode='22023'; end if;
  if not exists(select 1 from hub.course_links l join hub.content_items i on i.id=l.content_item_id where i.id=p_item_id
    and lower(l.penntrain_course_id)=p_plan->>'courseId' and i.kind='course' and i.source_system='penntrain') then
    raise exception 'Registered source identity changed.' using errcode='40001'; end if;
  if not coalesce(p_allow_legacy,false) and not exists(select 1 from private.course_creation_intents where registration->>'itemId'=p_item_id::text and result is not null)
    and not exists(select 1 from private.learning_distribution_observations where item_id=p_item_id and managed) then
    raise exception 'Legacy distribution rollout is not enabled.' using errcode='42501'; end if;
  foreach v_id in array v_selected loop
    if not exists(select 1 from hub.products where id=v_id and slug in ('carebase','pennsync','breathe','caremetric-emr','caremetric-go','caremetric-intel')
      and status<>'retired' and support_enabled and private.has_staff_permission('content.write',id)) then
      raise exception 'Current product publication permission required.' using errcode='42501'; end if;
  end loop;
  -- Scheduled placements also need explicit retirement; a future publication must
  -- not silently survive the reviewed selection.
  select coalesce(array_agg(product_id order by product_id),array[]::uuid[]) into v_actual_removed from hub.content_publications
    where item_id=p_item_id and (expires_at is null or expires_at>now()) and not(product_id=any(v_selected));
  if v_removed is distinct from v_actual_removed then raise exception 'Review every removed placement.' using errcode='40001'; end if;
  foreach v_id in array v_removed loop
    if not private.has_staff_permission('content.write',v_id) then raise exception 'Current retirement permission required.' using errcode='42501'; end if;
  end loop;
  if exists(select 1 from hub.content_publications where item_id=p_item_id and (expires_at is null or expires_at>now()))
    and p_plan->'confirmReplacement'<>'true'::jsonb then raise exception 'Confirm replacement of published placements.' using errcode='22023'; end if;
end; $$;
create function private.preview_course_distribution(p_request_id uuid,p_plan jsonb,p_payload text,p_observation_id uuid,p_allow_legacy boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_item uuid; v_intent private.learning_distribution_intents%rowtype; v_doc jsonb;
  v_observation private.learning_distribution_observations%rowtype; v_digest text; v_created timestamptz:=clock_timestamp(); v_preview jsonb;
begin
  v_actor:=private.current_distribution_actor();
  if p_request_id is null then raise exception 'Request identity required.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub-distribution-request:'||p_request_id::text,0));
  select * into v_intent from private.learning_distribution_intents where request_id=p_request_id for update;
  if found then
    if v_intent.actor_id is distinct from (v_actor->>'user_id')::uuid or v_intent.session_id is distinct from (v_actor->>'session_id')::uuid
      or v_intent.plan is distinct from p_plan or v_intent.source_payload is distinct from p_payload then
      raise exception 'Original distribution request required.' using errcode='40001'; end if;
    return private.distribution_intent_view(v_intent);
  end if;
  select i.id into v_item from hub.content_items i join hub.course_links l on l.content_item_id=i.id
    where lower(l.penntrain_course_id)=p_plan->>'courseId' and i.kind='course' and i.source_system='penntrain' for update of i;
  if v_item is null then raise exception 'Registered course required.' using errcode='22023'; end if;
  perform private.validate_course_distribution_plan(p_plan,v_item,p_allow_legacy);
  if private.distribution_catalog_digest((p_plan->>'courseId')::uuid) is distinct from p_plan->>'expectedCatalogDigest' then
    raise exception 'Catalog changed after review.' using errcode='40001'; end if;
  v_doc:=private.validate_governed_learning_source(p_payload,p_plan->>'sourceRevision');
  if v_doc->>'sourceCourseId' is distinct from p_plan->>'courseId' or v_doc->>'sourceVersionId' is distinct from p_plan->>'versionId'
    or v_doc->>'publicationState'<>'published' or v_doc->>'sourceVersionState'<>'published' then
    raise exception 'Current published source required.' using errcode='40001'; end if;
  select * into v_observation from private.learning_distribution_observations where course_id=(p_plan->>'courseId')::uuid for update;
  if not found or v_observation.observation_id is distinct from p_observation_id or v_observation.observed_at<clock_timestamp()-interval '2 minutes'
    or v_observation.source_revision is distinct from p_plan->>'sourceRevision' or v_observation.current_version_id is distinct from (p_plan->>'versionId')::uuid
    or v_observation.publication_state is distinct from 'published' or v_observation.current_version_state is distinct from 'published' then
    raise exception 'Published observation changed.' using errcode='40001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub-distribution-actor:'||(v_actor->>'user_id'),0));
  if (select count(*) from private.learning_distribution_intents where actor_id=(v_actor->>'user_id')::uuid and created_at>now()-interval '15 minutes')>=20 then
    raise exception 'Resume a saved distribution review.' using errcode='42501'; end if;
  v_digest:=encode(extensions.digest(jsonb_build_object('requestId',p_request_id,'actor',v_actor->>'user_id','session',v_actor->>'session_id','plan',p_plan)::text,'sha256'),'hex');
  v_preview:=jsonb_build_object('requestId',p_request_id,'plan',p_plan,'previewDigest',v_digest,'createdAt',v_created,'expiresAt',v_created+interval '5 minutes',
    'replacesPublished',exists(select 1 from hub.content_publications where item_id=v_item and (expires_at is null or expires_at>now())),'result',null);
  perform private.current_distribution_actor();
  insert into private.learning_distribution_intents(request_id,actor_id,session_id,course_id,item_id,plan,source_payload,source_revision,preview_digest,preview,created_at,expires_at)
    values(p_request_id,(v_actor->>'user_id')::uuid,(v_actor->>'session_id')::uuid,(p_plan->>'courseId')::uuid,v_item,p_plan,p_payload,p_plan->>'sourceRevision',v_digest,v_preview,v_created,v_created+interval '5 minutes') returning * into v_intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata) values(v_intent.actor_id,'learning.distribution.preview','content_item',v_item,
    jsonb_build_object('request_id',p_request_id,'source_revision',v_intent.source_revision));
  return private.distribution_intent_view(v_intent);
end; $$;
create function private.commit_course_distribution(p_request_id uuid,p_expected_digest text,p_observation_id uuid,p_allow_legacy boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.learning_distribution_intents%rowtype; v_observation private.learning_distribution_observations%rowtype;
  v_plan jsonb; v_before jsonb; v_revision uuid:=gen_random_uuid(); v_number integer; v_now timestamptz; v_result jsonb;
begin
  v_intent:=private.require_course_distribution_intent(p_request_id);v_plan:=v_intent.plan;
  if v_intent.session_id is distinct from (hub.authorize_app_command()->>'session_id')::uuid then
    raise exception 'Original distribution session required.' using errcode='42501';end if;
  if v_intent.preview_digest is distinct from p_expected_digest then raise exception 'Review digest changed.' using errcode='40001'; end if;
  -- A recovered receipt is evidence of the original commit, never a new approval.
  if v_intent.result is not null then return private.distribution_intent_view(v_intent); end if;
  if v_intent.expires_at<=clock_timestamp() then raise exception 'Distribution preview expired.' using errcode='40001'; end if;
  perform 1 from hub.content_items where id=v_intent.item_id for update;
  perform private.validate_course_distribution_plan(v_plan,v_intent.item_id,p_allow_legacy);
  if private.distribution_catalog_digest(v_intent.course_id) is distinct from v_plan->>'expectedCatalogDigest' then
    raise exception 'Catalog changed after review.' using errcode='40001'; end if;
  select * into v_observation from private.learning_distribution_observations where course_id=v_intent.course_id for update;
  if not found or v_observation.observation_id is distinct from p_observation_id or v_observation.observed_at is null
    or v_observation.observed_at<clock_timestamp()-interval '2 minutes' or v_observation.observer_verified_at is null
    or v_observation.observer_verified_at<clock_timestamp()-interval '2 minutes'
    or v_observation.source_revision is distinct from v_intent.source_revision or v_observation.observer_source_revision is distinct from v_intent.source_revision
    or v_observation.current_version_id is distinct from (v_plan->>'versionId')::uuid or v_observation.observer_version_id is distinct from (v_plan->>'versionId')::uuid
    or v_observation.publication_state is distinct from 'published' or v_observation.current_version_state is distinct from 'published' then
    raise exception 'A current matching observer and published source are required.' using errcode='40001'; end if;
  -- Locks may have waited past expiry. Recheck current actor/product scope after
  -- those waits, then record actual publication time immediately before writing.
  perform private.current_distribution_actor();perform private.validate_course_distribution_plan(v_plan,v_intent.item_id,p_allow_legacy);
  if v_intent.expires_at<=clock_timestamp() then raise exception 'Distribution preview expired.' using errcode='40001';end if;
  v_now:=clock_timestamp();
  v_before:=private.distribution_catalog_state(v_intent.course_id);
  select coalesce(max(revision_no),0)+1 into v_number from hub.content_revisions where item_id=v_intent.item_id;
  insert into hub.content_revisions(id,item_id,revision_no,title,summary,body_text,variables,source_hash,source_version,review_state,created_by,approved_by,approved_at)
    values(v_revision,v_intent.item_id,v_number,v_plan->'metadata'->>'title',v_plan->'metadata'->>'summary',
      'Course material and completion are maintained in CareBase.',jsonb_build_object('category',v_plan->'metadata'->'category','distribution_source','carebase'),
      v_intent.source_revision,v_plan->>'versionId','approved',v_intent.actor_id,v_intent.actor_id,v_now);
  insert into private.learning_distribution_revisions(revision_id,item_id,request_id,course_id,version_id,source_revision,before_catalog,plan,actor_id,session_id,published_at)
    values(v_revision,v_intent.item_id,p_request_id,v_intent.course_id,(v_plan->>'versionId')::uuid,v_intent.source_revision,v_before,v_plan,v_intent.actor_id,v_intent.session_id,v_now);
  update hub.content_items set status='published',access_level=(v_plan->>'accessLevel')::hub.access_level,retired_at=null,updated_at=v_now where id=v_intent.item_id;
  update hub.course_links set source_version=v_plan->>'versionId',duration_minutes=(v_plan->'metadata'->>'durationMinutes')::integer,source_updated_at=v_observation.native_generated_at,updated_at=v_now where content_item_id=v_intent.item_id;
  -- The immutable provenance retains the original rows, and the availability
  -- policy immediately excludes every previous revision, including schedules.
  update hub.content_publications set expires_at=greatest(v_now,published_at+interval '1 microsecond')
    where item_id=v_intent.item_id and product_id in(select value::uuid from jsonb_array_elements_text(v_plan->'removedProductIds'));
  insert into hub.content_publications(item_id,revision_id,product_id,audience,route_pattern,app_version_min,app_version_max,published_at,expires_at,published_by)
    select v_intent.item_id,v_revision,value::uuid,array['all']::text[],null,null,null,v_now,null,v_intent.actor_id from jsonb_array_elements_text(v_plan->'productIds')
    on conflict(item_id,product_id) do update set revision_id=excluded.revision_id,audience=excluded.audience,route_pattern=null,app_version_min=null,app_version_max=null,published_at=excluded.published_at,expires_at=null,published_by=excluded.published_by;
  update private.learning_distribution_observations set managed=true,distributed_revision_id=v_revision where course_id=v_intent.course_id;
  v_result:=jsonb_build_object('requestId',p_request_id,'itemId',v_intent.item_id,'revisionId',v_revision,'revisionNumber',v_number,'courseId',v_intent.course_id,
    'versionId',(v_plan->>'versionId')::uuid,'sourceRevision',v_intent.source_revision,'productIds',v_plan->'productIds','accessLevel',v_plan->>'accessLevel','publishedAt',v_now);
  update private.learning_distribution_intents set result=v_result where request_id=p_request_id returning * into v_intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata) values(v_intent.actor_id,'learning.distribution.committed','content_item',v_intent.item_id,
    jsonb_build_object('request_id',p_request_id,'revision_id',v_revision,'source_revision',v_intent.source_revision,'product_ids',v_plan->'productIds'));
  return private.distribution_intent_view(v_intent);
end; $$;
create function private.protect_course_distribution() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_table_schema='private' and tg_table_name='learning_distribution_intents' then
    if tg_op='UPDATE' and row(new.request_id,new.actor_id,new.session_id,new.course_id,new.item_id,new.plan,new.source_payload,new.source_revision,new.preview_digest,new.preview,new.created_at,new.expires_at) is not distinct from row(old.request_id,old.actor_id,old.session_id,old.course_id,old.item_id,old.plan,old.source_payload,old.source_revision,old.preview_digest,old.preview,old.created_at,old.expires_at) and old.result is null and new.result is not null then return new; end if;
    raise exception 'Distribution request and receipt are immutable.' using errcode='42501';
  end if;
  if tg_table_schema='private' then raise exception 'Distribution provenance is immutable.' using errcode='42501'; end if;
  if exists(select 1 from private.learning_distribution_revisions where revision_id=old.id)
    or exists(select 1 from private.learning_distribution_observations where item_id=old.item_id and managed) then
    raise exception 'Distributed revision is immutable.' using errcode='42501'; end if;
  if tg_op='DELETE' then return old; end if; return new;
end; $$;
create trigger learning_distribution_intent_immutable before update or delete on private.learning_distribution_intents for each row execute function private.protect_course_distribution();
create trigger learning_distribution_provenance_immutable before update or delete on private.learning_distribution_revisions for each row execute function private.protect_course_distribution();
create trigger learning_distribution_revision_immutable before update or delete on hub.content_revisions for each row execute function private.protect_course_distribution();

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
      and (item.kind<>'course' or item.source_system<>'penntrain' or private.course_distribution_available(item.id,revision.id))
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


create function private.release_distribution_status_batch(p_lease_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if session_user<>'hub_app_server' then raise exception 'Application observer required.' using errcode='42501'; end if;
  -- attempted_at remains the retry backoff. Failures never invent fresh evidence.
  update private.learning_distribution_observations set lease_id=null,lease_until=null where lease_id=p_lease_id;
end; $$;
revoke all on function private.current_distribution_actor(),private.distribution_catalog_state(uuid),private.distribution_catalog_digest(uuid),private.course_distribution_available(uuid,uuid),
  private.claim_course_distribution_observation(uuid),private.validate_distribution_status(jsonb),private.record_course_distribution_observation(uuid,uuid,timestamptz,jsonb,boolean),
  private.distribution_intent_view(private.learning_distribution_intents),private.distribution_availability(uuid),private.get_course_distribution_context(uuid),
  private.require_course_distribution_intent(uuid),private.get_course_distribution_intent(uuid),private.claim_distribution_status_batch(),private.record_distribution_status_batch(uuid,timestamptz,jsonb),
  private.release_distribution_status_batch(uuid),private.validate_course_distribution_plan(jsonb,uuid,boolean),private.preview_course_distribution(uuid,jsonb,text,uuid,boolean),
  private.commit_course_distribution(uuid,text,uuid,boolean),private.protect_course_distribution()
  from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.claim_course_distribution_observation(uuid),private.record_course_distribution_observation(uuid,uuid,timestamptz,jsonb,boolean),
  private.get_course_distribution_context(uuid),private.get_course_distribution_intent(uuid),private.preview_course_distribution(uuid,jsonb,text,uuid,boolean),
  private.commit_course_distribution(uuid,text,uuid,boolean),private.claim_distribution_status_batch(),private.record_distribution_status_batch(uuid,timestamptz,jsonb),
  private.release_distribution_status_batch(uuid) to hub_app_server;


-- Applied migration: 20260911234549_governed_course_distribution_contract.sql
-- Hub catalog distribution only. Native runtime and observer configuration are
-- independently checked at use; schema presence never declares them connected.
do $$
declare v_contract jsonb:=hub.get_backend_contract();v_table text;v_signature text;v_definition text;
begin
  if v_contract is null or not(v_contract @> '{"api_version":4,"features":["app.sms.v1","learning.sources.v1","learning.course-creation.v1"]}'::jsonb) then
    raise exception 'Reviewed course and session foundation required.' using errcode='55000';end if;
  if jsonb_array_length(v_contract->'features')>100 or exists(select 1 from jsonb_array_elements(v_contract->'features') j where jsonb_typeof(j.value)<>'string')
    or (select count(*)<>count(distinct value) from jsonb_array_elements(v_contract->'features')) then raise exception 'Invalid prior feature declaration.' using errcode='55000';end if;
  foreach v_table in array array['learning_distribution_observations','learning_distribution_intents','learning_distribution_revisions'] loop
    if to_regclass('private.'||v_table) is null then raise exception 'Distribution state missing.' using errcode='55000';end if;
    if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname=v_table and c.relrowsecurity)
      or has_table_privilege('anon','private.'||v_table,'select,insert,update,delete') or has_table_privilege('authenticated','private.'||v_table,'select,insert,update,delete')
      or has_table_privilege('service_role','private.'||v_table,'select,insert,update,delete') or has_table_privilege('hub_app_server','private.'||v_table,'select,insert,update,delete') then
      raise exception 'Distribution private state boundary missing.' using errcode='55000';end if;
  end loop;
  foreach v_signature in array array['private.get_course_distribution_context(uuid)','private.get_course_distribution_intent(uuid)',
    'private.claim_course_distribution_observation(uuid)','private.record_course_distribution_observation(uuid,uuid,timestamptz,jsonb,boolean)',
    'private.preview_course_distribution(uuid,jsonb,text,uuid,boolean)','private.commit_course_distribution(uuid,text,uuid,boolean)',
    'private.claim_distribution_status_batch()','private.record_distribution_status_batch(uuid,timestamptz,jsonb)','private.release_distribution_status_batch(uuid)'] loop
    if to_regprocedure(v_signature) is null then raise exception 'Distribution operation missing.' using errcode='55000';end if;
    if not has_function_privilege('hub_app_server',v_signature,'execute') or has_function_privilege('anon',v_signature,'execute')
      or has_function_privilege('authenticated',v_signature,'execute') or has_function_privilege('service_role',v_signature,'execute') then
      raise exception 'Distribution function boundary missing.' using errcode='55000';end if;
  end loop;
  if to_regprocedure('private.current_distribution_actor()') is null or to_regprocedure('private.course_distribution_available(uuid,uuid)') is null or to_regprocedure('private.validate_course_distribution_plan(jsonb,uuid,boolean)') is null
    or to_regprocedure('private.protect_course_distribution()') is null then raise exception 'Distribution policy missing.' using errcode='55000';end if;
  select pg_get_functiondef('private.commit_course_distribution(uuid,text,uuid,boolean)'::regprocedure) into v_definition;
  if position('require_course_distribution_intent' in v_definition)=0 or position('observer_verified_at' in v_definition)=0
    or position('distribution_catalog_digest' in v_definition)=0 or position('observation_id' in v_definition)=0
    or position('validate_course_distribution_plan' in v_definition)=0 or position('learning_distribution_revisions' in v_definition)=0 or position('current_distribution_actor' in v_definition)=0 then
    raise exception 'Distribution commit guards missing.' using errcode='55000';end if;
  if position('clock_timestamp' in pg_get_functiondef('private.current_distribution_actor()'::regprocedure))=0
    or position('480 minutes' in pg_get_functiondef('private.current_distribution_actor()'::regprocedure))=0 then raise exception 'Distribution wall-clock authority missing.' using errcode='55000';end if;
  if position('course_distribution_available' in pg_get_functiondef('private.can_access_content_publication(uuid,uuid,uuid)'::regprocedure))=0
    or position('15 minutes' in pg_get_functiondef('private.course_distribution_available(uuid,uuid)'::regprocedure))=0
    or position('distributed_revision_id' in pg_get_functiondef('private.course_distribution_available(uuid,uuid)'::regprocedure))=0 then
    raise exception 'Distribution availability policy missing.' using errcode='55000';end if;
  if (select count(*) from pg_trigger where tgname in ('learning_distribution_intent_immutable','learning_distribution_provenance_immutable','learning_distribution_revision_immutable')
    and tgenabled in ('O','A') and tgfoid='private.protect_course_distribution()'::regprocedure)<>3 then
    raise exception 'Distribution immutability guards missing.' using errcode='55000';end if;
  if not(v_contract->'features' @> '["learning.distribution.v1"]'::jsonb) then
    v_contract:=jsonb_set(v_contract,'{features}',(v_contract->'features')||'["learning.distribution.v1"]'::jsonb);end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(v_contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;


-- Appended migration: 20260912002000_pennsync_learning_source.sql
-- Immutable private migration evidence. This does not grant learner access,
-- publish source content, issue credits, or alter PennSync's source records.
create table private.pennsync_learning_snapshots (
 id uuid primary key default gen_random_uuid(),
 source_revision text not null unique check(source_revision ~ '^[0-9a-f]{64}$'),
 sequence integer not null unique check(sequence>0),
 source_payload text not null check(octet_length(source_payload)<=7000000),
 summary jsonb not null,
 staged_by uuid not null references auth.users(id),
 staged_at timestamptz not null default now()
);
create index pennsync_learning_snapshots_actor_idx on private.pennsync_learning_snapshots(staged_by);
alter table private.pennsync_learning_snapshots enable row level security;
revoke all on private.pennsync_learning_snapshots from public,anon,authenticated,service_role,hub_app_server;

create function private.pennsync_learning_source_schema() returns json
language sql immutable set search_path='' as $$ select $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"contract":{"type":"string","const":"pennsync.learning-source.v1"},"sourceAppId":{"type":"string","const":"694ec16e72e01b60d22f7cbf"},"scope":{"type":"string","const":"private-administrator-migration"},"records":{"type":"object","properties":{"TrainingCourse":{"maxItems":10000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[a-f0-9]{24}$"},"revision":{"type":"string","pattern":"^[a-f0-9]{64}$"},"fields":{"type":"object","propertyNames":{"type":"string","maxLength":160},"additionalProperties":{"$ref":"#/definitions/__schema0"}}},"required":["id","revision","fields"],"additionalProperties":false}},"TrainingModule":{"maxItems":10000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[a-f0-9]{24}$"},"revision":{"type":"string","pattern":"^[a-f0-9]{64}$"},"fields":{"type":"object","propertyNames":{"type":"string","maxLength":160},"additionalProperties":{"$ref":"#/definitions/__schema0"}}},"required":["id","revision","fields"],"additionalProperties":false}},"TrainingQuestion":{"maxItems":10000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[a-f0-9]{24}$"},"revision":{"type":"string","pattern":"^[a-f0-9]{64}$"},"fields":{"type":"object","propertyNames":{"type":"string","maxLength":160},"additionalProperties":{"$ref":"#/definitions/__schema0"}}},"required":["id","revision","fields"],"additionalProperties":false}},"TrainingCompletion":{"maxItems":10000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[a-f0-9]{24}$"},"revision":{"type":"string","pattern":"^[a-f0-9]{64}$"},"fields":{"type":"object","propertyNames":{"type":"string","maxLength":160},"additionalProperties":{"$ref":"#/definitions/__schema0"}}},"required":["id","revision","fields"],"additionalProperties":false}},"TrainingAssignment":{"maxItems":10000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[a-f0-9]{24}$"},"revision":{"type":"string","pattern":"^[a-f0-9]{64}$"},"fields":{"type":"object","propertyNames":{"type":"string","maxLength":160},"additionalProperties":{"$ref":"#/definitions/__schema0"}}},"required":["id","revision","fields"],"additionalProperties":false}},"TrainingAttempt":{"maxItems":10000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[a-f0-9]{24}$"},"revision":{"type":"string","pattern":"^[a-f0-9]{64}$"},"fields":{"type":"object","propertyNames":{"type":"string","maxLength":160},"additionalProperties":{"$ref":"#/definitions/__schema0"}}},"required":["id","revision","fields"],"additionalProperties":false}},"TrainingAttestation":{"maxItems":10000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[a-f0-9]{24}$"},"revision":{"type":"string","pattern":"^[a-f0-9]{64}$"},"fields":{"type":"object","propertyNames":{"type":"string","maxLength":160},"additionalProperties":{"$ref":"#/definitions/__schema0"}}},"required":["id","revision","fields"],"additionalProperties":false}},"TrainingCertificate":{"maxItems":10000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[a-f0-9]{24}$"},"revision":{"type":"string","pattern":"^[a-f0-9]{64}$"},"fields":{"type":"object","propertyNames":{"type":"string","maxLength":160},"additionalProperties":{"$ref":"#/definitions/__schema0"}}},"required":["id","revision","fields"],"additionalProperties":false}},"LearningPlan":{"maxItems":10000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[a-f0-9]{24}$"},"revision":{"type":"string","pattern":"^[a-f0-9]{64}$"},"fields":{"type":"object","propertyNames":{"type":"string","maxLength":160},"additionalProperties":{"$ref":"#/definitions/__schema0"}}},"required":["id","revision","fields"],"additionalProperties":false}},"LearningPlanCourse":{"maxItems":10000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[a-f0-9]{24}$"},"revision":{"type":"string","pattern":"^[a-f0-9]{64}$"},"fields":{"type":"object","propertyNames":{"type":"string","maxLength":160},"additionalProperties":{"$ref":"#/definitions/__schema0"}}},"required":["id","revision","fields"],"additionalProperties":false}},"User":{"maxItems":10000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[a-f0-9]{24}$"},"revision":{"type":"string","pattern":"^[a-f0-9]{64}$"},"fields":{"type":"object","propertyNames":{"type":"string","maxLength":160},"additionalProperties":{"$ref":"#/definitions/__schema0"}}},"required":["id","revision","fields"],"additionalProperties":false}},"Agency":{"maxItems":10000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[a-f0-9]{24}$"},"revision":{"type":"string","pattern":"^[a-f0-9]{64}$"},"fields":{"type":"object","propertyNames":{"type":"string","maxLength":160},"additionalProperties":{"$ref":"#/definitions/__schema0"}}},"required":["id","revision","fields"],"additionalProperties":false}},"AgencyMembership":{"maxItems":10000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[a-f0-9]{24}$"},"revision":{"type":"string","pattern":"^[a-f0-9]{64}$"},"fields":{"type":"object","propertyNames":{"type":"string","maxLength":160},"additionalProperties":{"$ref":"#/definitions/__schema0"}}},"required":["id","revision","fields"],"additionalProperties":false}}},"required":["TrainingCourse","TrainingModule","TrainingQuestion","TrainingCompletion","TrainingAssignment","TrainingAttempt","TrainingAttestation","TrainingCertificate","LearningPlan","LearningPlanCourse","User","Agency","AgencyMembership"],"additionalProperties":false},"references":{"maxItems":10000,"type":"array","items":{"type":"object","properties":{"entity":{"type":"string","enum":["TrainingCourse","TrainingModule","TrainingQuestion","TrainingCompletion","TrainingAssignment","TrainingAttempt","TrainingAttestation","TrainingCertificate","LearningPlan","LearningPlanCourse","User","Agency","AgencyMembership"]},"sourceId":{"type":"string","pattern":"^[a-f0-9]{24}$"},"path":{"type":"string","maxLength":2000},"sha256":{"type":"string","pattern":"^[a-f0-9]{64}$"},"kind":{"type":"string","enum":["source_reference","embedded_reference"]}},"required":["entity","sourceId","path","sha256","kind"],"additionalProperties":false}}},"required":["contract","sourceAppId","scope","records","references"],"additionalProperties":false,"definitions":{"__schema0":{"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"},{"type":"array","items":{"$ref":"#/definitions/__schema0"}},{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"$ref":"#/definitions/__schema0"}}]}}}$schema$::json $$;
create function private.pennsync_learning_summary_schema() returns json
language sql immutable set search_path='' as $$ select $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"courses":{"type":"integer","minimum":0,"maximum":9007199254740991},"modules":{"type":"integer","minimum":0,"maximum":9007199254740991},"standaloneModules":{"type":"integer","minimum":0,"maximum":9007199254740991},"questions":{"type":"integer","minimum":0,"maximum":9007199254740991},"plans":{"type":"integer","minimum":0,"maximum":9007199254740991},"planCourses":{"type":"integer","minimum":0,"maximum":9007199254740991},"historyRecords":{"type":"integer","minimum":0,"maximum":9007199254740991},"unmatchedLegacyLearners":{"type":"integer","minimum":0,"maximum":9007199254740991},"ambiguousLegacyLearners":{"type":"integer","minimum":0,"maximum":9007199254740991},"sourceReferences":{"type":"integer","minimum":0,"maximum":9007199254740991},"brokenReferences":{"type":"integer","minimum":0,"maximum":9007199254740991},"catalog":{"maxItems":20000,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[a-f0-9]{24}$"},"kind":{"type":"string","enum":["course","standalone_module"]},"title":{"type":"string","maxLength":500},"status":{"type":"string","maxLength":80},"modules":{"type":"integer","minimum":0,"maximum":9007199254740991},"questions":{"type":"integer","minimum":0,"maximum":9007199254740991},"issues":{"maxItems":25,"type":"array","items":{"type":"string","maxLength":150}}},"required":["id","kind","title","status","modules","questions","issues"],"additionalProperties":false}}},"required":["courses","modules","standaloneModules","questions","plans","planCourses","historyRecords","unmatchedLegacyLearners","ambiguousLegacyLearners","sourceReferences","brokenReferences","catalog"],"additionalProperties":false}$schema$::json $$;

create function private.pennsync_learning_head() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform hub.authorize_app_command(); perform private.require_learning_editor();
 select jsonb_build_object('snapshotId',id,'sourceRevision',source_revision,'sequence',sequence,'summary',summary)
 into result from private.pennsync_learning_snapshots order by sequence desc limit 1;
 return result;
end $$;

create function private.pennsync_learning_preserve(p_payload text,p_revision text,p_expected_revision text,p_summary jsonb,p_deadline timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; authority jsonb; doc jsonb; head private.pennsync_learning_snapshots%rowtype; prior private.pennsync_learning_snapshots%rowtype;
begin
 perform hub.authorize_app_command(); actor:=private.require_learning_editor();
 if p_payload is null or octet_length(p_payload)>7000000 or p_revision is null or p_revision !~ '^[0-9a-f]{64}$'
   or encode(extensions.digest(p_payload,'sha256'),'hex')<>p_revision then
   raise exception 'Invalid source checksum' using errcode='22023'; end if;
 doc:=p_payload::jsonb;
 if not extensions.jsonb_matches_schema(private.pennsync_learning_source_schema(),doc)
   or p_summary is null or not extensions.jsonb_matches_schema(private.pennsync_learning_summary_schema(),p_summary) then
   raise exception 'Invalid source contract' using errcode='22023'; end if;
 if p_summary->>'courses'<>jsonb_array_length(doc#>'{records,TrainingCourse}')::text
   or p_summary->>'modules'<>jsonb_array_length(doc#>'{records,TrainingModule}')::text
   or p_summary->>'questions'<>jsonb_array_length(doc#>'{records,TrainingQuestion}')::text then
   raise exception 'Source summary does not match' using errcode='22023'; end if;
 if p_deadline is null or p_deadline<=clock_timestamp() or p_deadline>clock_timestamp()+interval '20 seconds' then raise exception 'Source request expired' using errcode='57014';end if;
 perform pg_advisory_xact_lock(hashtextextended('pennsync.learning-source.v1',0));
 -- The clock and authority must be checked after lock wait, using fresh reads.
 authority:=hub.authorize_app_command(); actor:=private.require_learning_editor();
 if p_deadline<=clock_timestamp() then raise exception 'Source request expired' using errcode='57014';end if;
 if (authority->>'assurance_expires_at')::timestamptz<=clock_timestamp() or not exists(
   select 1 from private.sms_sessions s join private.sms_identities i on i.user_id=s.user_id and i.identity_version=s.identity_version
   where s.id=(authority->>'session_id')::uuid and s.user_id=actor and s.revoked_at is null and i.revoked_at is null
     and s.expires_at>clock_timestamp() and s.created_at+interval '8 hours'>clock_timestamp()) then
   raise exception 'Current administrator session required' using errcode='28000';end if;
 select * into head from private.pennsync_learning_snapshots order by sequence desc limit 1;
 select * into prior from private.pennsync_learning_snapshots where source_revision=p_revision;
 if found then
   if prior.source_payload<>p_payload or prior.summary<>p_summary then raise exception 'Source evidence changed' using errcode='40001'; end if;
   return jsonb_build_object('snapshotId',prior.id,'sourceRevision',prior.source_revision,'headRevision',head.source_revision,'replayed',true,'summary',prior.summary);
 end if;
 if p_expected_revision is distinct from head.source_revision then raise exception 'Source head changed' using errcode='40001'; end if;
 insert into private.pennsync_learning_snapshots(source_revision,sequence,source_payload,summary,staged_by)
 values(p_revision,coalesce(head.sequence,0)+1,p_payload,p_summary,actor) returning * into prior;
 insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
 values(actor,'learning.pennsync.source_preserved','learning_source',prior.id,jsonb_build_object('source_revision',p_revision,'sequence',prior.sequence));
 return jsonb_build_object('snapshotId',prior.id,'sourceRevision',p_revision,'headRevision',p_revision,'replayed',false,'summary',p_summary);
end $$;
revoke all on function private.pennsync_learning_source_schema(),private.pennsync_learning_summary_schema(),private.pennsync_learning_head(),private.pennsync_learning_preserve(text,text,text,jsonb,timestamptz)
 from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.pennsync_learning_head(),private.pennsync_learning_preserve(text,text,text,jsonb,timestamptz) to hub_app_server;


-- Appended migration: 20260912002100_pennsync_learning_contract.sql
do $$ declare contract jsonb:=hub.get_backend_contract(); signature text; role_name text; begin
 if not (contract @> '{"api_version":4,"features":["learning.sources.v1","app.sms.v1"]}'::jsonb) then
  raise exception 'Apply source and SMS foundations first' using errcode='55000'; end if;
 if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname='pennsync_learning_snapshots' and c.relrowsecurity) then
  raise exception 'Private PennSync source storage required' using errcode='55000';end if;
 foreach role_name in array array['anon','authenticated','service_role','hub_app_server'] loop
  if has_table_privilege(role_name,'private.pennsync_learning_snapshots','select,insert,update,delete') then raise exception 'PennSync source boundary invalid' using errcode='55000';end if;
 end loop;
 foreach signature in array array['private.pennsync_learning_head()','private.pennsync_learning_preserve(text,text,text,jsonb,timestamptz)'] loop
  if to_regprocedure(signature) is null or not has_function_privilege('hub_app_server',signature,'execute') then raise exception 'Missing PennSync source operation' using errcode='55000';end if;
  foreach role_name in array array['anon','authenticated','service_role'] loop
   if has_function_privilege(role_name,signature,'execute') then raise exception 'PennSync source operation exposed' using errcode='55000';end if;
  end loop;
 end loop;
 if not (contract->'features' @> '["learning.pennsync-source.v1"]'::jsonb) then contract:=jsonb_set(contract,'{features}',(contract->'features')||'["learning.pennsync-source.v1"]'::jsonb);end if;
 execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;


-- Optional immutable media references; existing source payloads and ACLs remain unchanged.
create or replace function private.governed_learning_schema() returns json
language sql immutable set search_path='' as $$
select $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"contract":{"type":"string","const":"carebase.course.v1"},"sourceCourseId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sourceVersionId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sourceVersionNumber":{"type":"integer","minimum":-2147483648,"maximum":2147483647},"publicationState":{"type":"string","enum":["draft","published","archived"]},"sourceVersionState":{"type":"string","enum":["draft","published"]},"course":{"type":"object","properties":{"title":{"type":"string","maxLength":250000},"description":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"category":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"estimatedDurationMinutes":{"anyOf":[{"type":"integer","minimum":0,"maximum":2147483647},{"type":"null"}]},"catalogCode":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"recurrenceIntervalDays":{"anyOf":[{"type":"integer","minimum":1,"maximum":2147483647},{"type":"null"}]},"legacyTrainingTypeId":{"anyOf":[{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},{"type":"null"}]},"renewalTrainingTypeId":{"anyOf":[{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},{"type":"null"}]},"creditedDurationCheckExempt":{"type":"boolean"}},"required":["title","description","category","estimatedDurationMinutes","catalogCode","recurrenceIntervalDays","legacyTrainingTypeId","renewalTrainingTypeId","creditedDurationCheckExempt"],"additionalProperties":false},"version":{"type":"object","properties":{"title":{"type":"string","maxLength":250000},"description":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"label":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"contentStandard":{"type":"string","enum":["legacy","comprehensive"]},"creditedDurationRationale":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"aiGenerated":{"type":"boolean"},"aiReviewedAt":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]}},"required":["title","description","label","contentStandard","creditedDurationRationale","aiGenerated","aiReviewedAt"],"additionalProperties":false},"blocks":{"maxItems":500,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"type":{"type":"string","enum":["text","video","pdf","scorm","quiz","attestation"]},"sortOrder":{"type":"integer","minimum":-2147483648,"maximum":2147483647},"title":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"body":{"$ref":"#/definitions/__schema0"},"documentId":{"anyOf":[{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},{"type":"null"}]},"videoLocatorSha256":{"anyOf":[{"type":"string","pattern":"^[0-9a-f]{64}$"},{"type":"null"}]},"mediaAsset":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"contentSha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"mimeType":{"type":"string","enum":["application/pdf","video/mp4","video/webm"]},"byteSize":{"type":"integer","exclusiveMinimum":0,"maximum":104857600},"fileName":{"type":"string","minLength":1,"maxLength":320}},"required":["id","contentSha256","mimeType","byteSize","fileName"],"additionalProperties":false},"quiz":{"anyOf":[{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"title":{"type":"string","maxLength":250000},"passingScore":{"type":"integer","minimum":0,"maximum":100},"maxAttempts":{"anyOf":[{"type":"integer","minimum":1,"maximum":2147483647},{"type":"null"}]},"kind":{"type":"string","enum":["assessment","knowledge_check","final_exam"]},"shuffleQuestions":{"type":"boolean"},"shuffleAnswers":{"type":"boolean"},"revealsAnswersAfterAttempt":{"type":"boolean"},"questions":{"maxItems":500,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sortOrder":{"type":"integer","minimum":-2147483648,"maximum":2147483647},"prompt":{"type":"string","maxLength":250000},"type":{"type":"string","enum":["single_choice","multiple_choice","true_false"]},"points":{"type":"integer","minimum":1,"maximum":2147483647},"topicCode":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"topicLabel":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"explanation":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"options":{"maxItems":100,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sortOrder":{"type":"integer","minimum":-2147483648,"maximum":2147483647},"text":{"type":"string","maxLength":250000},"correct":{"type":"boolean"}},"required":["id","sortOrder","text","correct"],"additionalProperties":false}}},"required":["id","sortOrder","prompt","type","points","topicCode","topicLabel","explanation","options"],"additionalProperties":false}}},"required":["id","title","passingScore","maxAttempts","kind","shuffleQuestions","shuffleAnswers","revealsAnswersAfterAttempt","questions"],"additionalProperties":false},{"type":"null"}]}},"required":["id","type","sortOrder","title","body","documentId","videoLocatorSha256","quiz"],"additionalProperties":false}},"credits":{"maxItems":100,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"trainingTypeId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"topicCode":{"type":"string","maxLength":250000},"creditHours":{"type":"string","pattern":"^\\d{1,4}(\\.\\d{1,2})?$"},"mode":{"type":"string","enum":["automatic","verified_only"]},"citationNote":{"type":"string","maxLength":250000},"active":{"type":"boolean"}},"required":["id","trainingTypeId","topicCode","creditHours","mode","citationNote","active"],"additionalProperties":false}},"provider":{"anyOf":[{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"fullName":{"type":"string","maxLength":250000},"professionalTitle":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"credential":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"credentialNumber":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"credentialIssuingOrganization":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"credentialExpiresOn":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"courseAuthor":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"signatureName":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"signatureRecordedAt":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"contentVersion":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"lastClinicalReviewDate":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"reviewedBy":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"nextReviewDue":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"regulationReviewDate":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"reviewNotes":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]}},"required":["id","fullName","professionalTitle","credential","credentialNumber","credentialIssuingOrganization","credentialExpiresOn","courseAuthor","signatureName","signatureRecordedAt","contentVersion","lastClinicalReviewDate","reviewedBy","nextReviewDue","regulationReviewDate","reviewNotes"],"additionalProperties":false},{"type":"null"}]},"packages":{"maxItems":100,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"standard":{"type":"string","enum":["scorm_1_2","scorm_2004_4th","xapi","lti_1_3"]},"contentSha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"entryPoint":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"manifest":{"$ref":"#/definitions/__schema1"},"capabilities":{"maxItems":100,"type":"array","items":{"type":"string","maxLength":250000}},"connectivityMode":{"type":"string","enum":["online_only","offline_supported"]},"validationStatus":{"type":"string","enum":["pending","validating","accepted","rejected","quarantined"]}},"required":["id","standard","contentSha256","entryPoint","manifest","capabilities","connectivityMode","validationStatus"],"additionalProperties":false}}},"required":["contract","sourceCourseId","sourceVersionId","sourceVersionNumber","publicationState","sourceVersionState","course","version","blocks","credits","provider","packages"],"additionalProperties":false,"definitions":{"__schema0":{"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"},{"type":"array","items":{"$ref":"#/definitions/__schema0"}},{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"$ref":"#/definitions/__schema0"}}]},"__schema1":{"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"},{"type":"array","items":{"$ref":"#/definitions/__schema1"}},{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"$ref":"#/definitions/__schema1"}}]}}}$schema$::json;
$$;

create or replace function private.validate_governed_learning_source(p_payload text, p_revision text) returns jsonb
language plpgsql set search_path='' as $$
declare document jsonb;
begin
  if p_payload is null or octet_length(p_payload)>2000000 or p_revision is null
    or p_revision !~ '^[0-9a-f]{64}$'
    or encode(extensions.digest(p_payload,'sha256'),'hex')<>p_revision then
    raise exception 'Source revision checksum or size is invalid.' using errcode='22023';
  end if;
  begin document:=p_payload::jsonb;
  exception when invalid_text_representation then
    raise exception 'Source payload is not valid JSON.' using errcode='22023';
  end;
  if not extensions.jsonb_matches_schema(private.governed_learning_schema(),document) then
    raise exception 'Source snapshot does not match carebase.course.v1.' using errcode='22023';
  end if;
  if document::text ~* '([?&](token|access_token|signature|sig|key|policy|jwt|auth|h|hdnts|hdnea|key-pair-id|api_key|apikey|x-amz-[a-z-]+|x-goog-[a-z-]+)=|"(access_?token|refresh_?token|service_?role_?key|authorization|password|client_?secret|storage_?(path|bucket)|video_?url|playback_?(url|token)|signed_?url|api_?key|token|secret|secret_?key|signing_?secret)"[[:space:]]*:)' then
    raise exception 'Remove playback credentials from the source export before staging.' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(document->'blocks') b
    where (b->>'type'<>'quiz' and b->'quiz'<>'null'::jsonb)
      or (b->>'type'='quiz' and b->'quiz'='null'::jsonb and document->>'sourceVersionState'<>'draft')
      or ((b->'quiz'->>'revealsAnswersAfterAttempt')::boolean and b->'quiz'->>'kind'<>'knowledge_check')) then
    raise exception 'Source quiz configuration is invalid.' using errcode='22023';
  end if;
  if exists(
    with blocks as(select value b from jsonb_array_elements(document->'blocks')),
    questions as(select q from blocks cross join lateral jsonb_array_elements(coalesce(nullif(b->'quiz'->'questions','null'::jsonb),'[]'::jsonb)) q),
    ids as (
      select 'block' kind, lower(b->>'id') id from blocks
      union all select 'quiz',lower(b->'quiz'->>'id') from blocks where b->'quiz'<>'null'::jsonb
      union all select 'question',lower(q->>'id') from questions
      union all select 'answer',lower(a->>'id') from questions cross join lateral jsonb_array_elements(q->'options') a
      union all select 'credit',lower(c->>'id') from jsonb_array_elements(document->'credits') c
      union all select 'package',lower(p->>'id') from jsonb_array_elements(document->'packages') p
    ) select 1 from ids group by kind,id having count(*)>1
  ) then raise exception 'The source snapshot repeats a content identifier.' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(document->'blocks') b where b ? 'mediaAsset' and (
    b->>'type' not in ('pdf','video') or ((b->>'type'='pdf') is distinct from (b->'mediaAsset'->>'mimeType'='application/pdf'))
    or b->'documentId'<>'null'::jsonb or b->'videoLocatorSha256'<>'null'::jsonb
    or (b->'mediaAsset'->>'mimeType'='application/pdf' and (b->'mediaAsset'->>'byteSize')::bigint>26214400)
    or char_length(b->'mediaAsset'->>'fileName')>160
    or ascii(left(b->'mediaAsset'->>'fileName',1)) in (9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)
    or ascii(right(b->'mediaAsset'->>'fileName',1)) in (9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)
    or b->'mediaAsset'->>'fileName'<>normalize(b->'mediaAsset'->>'fileName',NFC)
    or exists(select 1 from regexp_split_to_table(b->'mediaAsset'->>'fileName','') letter
      where ascii(letter) between 1 and 31 or ascii(letter) between 127 and 159 or ascii(letter) in (47,58,92))
  )) then raise exception 'Source media attachment is invalid.' using errcode='22023'; end if;
  return document;
end;
$$;

-- This feature declares source-reference compatibility, not native media enablement.
-- Native capabilities remain independently disabled until their reviewed release.
do $$ declare contract jsonb:=hub.get_backend_contract(); begin
 if not (contract @> '{"api_version":4,"features":["app.sms.v1","learning.sources.v1"]}'::jsonb) then
  raise exception 'Apply the governed source and SMS foundations first' using errcode='55000'; end if;
 if private.governed_learning_schema()::jsonb#>'{properties,blocks,items,properties,mediaAsset}' is null
  or position('Source media attachment is invalid.' in pg_get_functiondef('private.validate_governed_learning_source(text,text)'::regprocedure))=0
  or has_function_privilege('authenticated','private.validate_governed_learning_source(text,text)','execute')
  or has_function_privilege('anon','private.validate_governed_learning_source(text,text)','execute') then
  raise exception 'Private immutable source media validation is required' using errcode='55000'; end if;
 if not (contract->'features' @> '["learning.media.v1"]'::jsonb) then
  contract:=jsonb_set(contract,'{features}',(contract->'features')||'["learning.media.v1"]'::jsonb); end if;
 execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- Exact preserved source is returned only to the application server after a
-- current SMS administrator check. Browser review uses a separate projection.
create function private.pennsync_learning_review_source(p_revision text) returns text
language plpgsql security definer set search_path='' as $$
declare actor uuid; authority jsonb; snapshot private.pennsync_learning_snapshots%rowtype;
begin
 authority:=hub.authorize_app_command(); actor:=private.require_learning_editor();
 if (authority->>'assurance_expires_at')::timestamptz<=clock_timestamp() or not exists(
   select 1 from private.sms_sessions s join private.sms_identities i on i.user_id=s.user_id and i.identity_version=s.identity_version
   where s.id=(authority->>'session_id')::uuid and s.user_id=actor and s.revoked_at is null and i.revoked_at is null
     and s.expires_at>clock_timestamp() and s.created_at+interval '8 hours'>clock_timestamp()) then
   raise exception 'Current administrator session required' using errcode='28000';end if;
 if p_revision is null or p_revision !~ '^[a-f0-9]{64}$' then raise exception 'Invalid source revision' using errcode='22023';end if;
 select * into snapshot from private.pennsync_learning_snapshots order by sequence desc limit 1;
 if not found or snapshot.source_revision<>p_revision then raise exception 'Preserved source head changed' using errcode='40001';end if;
 return snapshot.source_payload;
end $$;
revoke all on function private.pennsync_learning_review_source(text) from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.pennsync_learning_review_source(text) to hub_app_server;

-- Phone inventory (20260925020325_phone_number_registry.sql)
-- Business phone inventory only. Never stores callers, recordings or credentials.
create table if not exists private.phone_numbers (
  id uuid primary key default gen_random_uuid(),
  number text not null unique check (number ~ '^\+[1-9][0-9]{7,14}$'),
  record jsonb not null check (jsonb_typeof(record)='object'),
  version integer not null default 1 check (version>0),
  updated_at timestamptz not null default now()
);
alter table private.phone_numbers enable row level security;
revoke all on private.phone_numbers from public,anon,authenticated,hub_app_server;
comment on table private.phone_numbers is 'Administrator-maintained phone inventory; dated observations, not live provider monitoring.';

create or replace function hub.list_phone_numbers() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform hub.authorize_app_admin();
  select coalesce(jsonb_agg(record || jsonb_build_object('id',id,'version',version,'updated_at',updated_at) order by number),'[]'::jsonb) into result
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
insert into private.phone_numbers(number,record) values('+18775212890','{"provider":"Twilio","account":"CareMetric AI","owner":"","lifecycle":"active","usage_status":"observed","voice_status":"configured","sms_status":"pending","last_used_on":"","reviewed_on":"2026-09-24","evidence":"Twilio showed a completed voice call returning HTTP 200 and opening the voice stream during the September 24 audit. No outgoing SMS records were shown in the available log view; this does not establish historical nonuse.","notes":"Shared business assistant deployed. Requested link texts are disabled pending replacement SMS verification approval. Existing approval describes patient reminders/2FA with web-form consent. Replacement authorized but awaiting Twilio browser sign-in.","voice_routing":"https://cmbreathe.com/resupply-api/voice/inbound-breathe-sales","sms_routing":"CareMetric AI service; inbound POST https://cmbreathe.com/resupply-api/sms/caremetric-inbound","number":"+18775212890","label":"CareMetric shared support and Advisors","purpose":"Software technical support, customer service, and Healthcare Advisors reception.","apps":"All CareMetric software; CareMetric Healthcare Advisors"}'::jsonb) on conflict (number) do nothing;
insert into private.phone_numbers(number,record) values('+18333489271','{"provider":"Twilio","account":"CareMetric AI","owner":"","lifecycle":"active","usage_status":"unknown","voice_status":"configured","sms_status":"rejected","last_used_on":"","reviewed_on":"2026-09-24","evidence":"Twilio Console configuration inspected September 24, 2026. Configuration alone does not prove recent traffic.","notes":"Twilio showed rejected toll-free SMS verification. Keep separate from software support. Actual recent call/text usage has not been verified.","voice_routing":"https://pennpaps.com/resupply-api/voice/inbound-reorder","sms_routing":"","number":"+18333489271","label":"PennPaps patient reorder — 833","purpose":"Patient supply reordering.","apps":"PennPaps patient operations"}'::jsonb) on conflict (number) do nothing;
insert into private.phone_numbers(number,record) values('+18559542809','{"provider":"Twilio","account":"CareMetric AI","owner":"","lifecycle":"active","usage_status":"unknown","voice_status":"configured","sms_status":"unknown","last_used_on":"","reviewed_on":"2026-09-24","evidence":"Twilio Console configuration inspected September 24, 2026. Configuration alone does not prove recent traffic.","notes":"Do not consolidate with the shared software-support line without checking patient workflows. SMS approval and actual traffic still need review.","voice_routing":"https://pennpaps.com/resupply-api/voice/inbound-reorder","sms_routing":"Separate marketing messaging service (observed in Twilio).","number":"+18559542809","label":"PennPaps patient reorder — 855","purpose":"Patient supply reordering; separate messaging service.","apps":"PennPaps patient operations"}'::jsonb) on conflict (number) do nothing;
insert into private.phone_numbers(number,record) values('+18149169606','{"provider":"Twilio","account":"CareMetric AI","owner":"","lifecycle":"active","usage_status":"unknown","voice_status":"configured","sms_status":"configured","last_used_on":"","reviewed_on":"2026-09-24","evidence":"Twilio Console configuration inspected September 24, 2026. Configuration alone does not prove recent traffic.","notes":"Preserve patient operations. Actual recent call/text usage has not been verified.","voice_routing":"https://pennpaps.com/resupply-api/voice/inbound-reorder","sms_routing":"Patient SMS Customer Care A2P Messaging Service.","number":"+18149169606","label":"PennPaps patient voice and SMS","purpose":"Patient supply reordering and patient SMS.","apps":"PennPaps patient operations"}'::jsonb) on conflict (number) do nothing;


-- Phone registry deployment contract
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
  if not (contract->'features' @> '["phone.registry.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["phone.registry.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;

-- Tenant phone account inventory
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

-- Additive deployment gate for ordered course delivery: units open in course order, a published
-- course ends with a graded post-test after its last lesson, and the certificate reports the
-- post-test score. A frontend that relies on these rules must not deploy against a backend
-- that still accepts out-of-order units or publishes a course without a post-test.
do $$ declare contract jsonb:=hub.get_backend_contract(); begin
  if (contract @> '{"api_version":4,"features":["learning.runtime.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub learning runtime first' using errcode='55000';
  end if;
  if position('Complete the earlier lessons in order before continuing.'
      in pg_get_functiondef('hub.submit_learning_unit(uuid,uuid,jsonb,boolean,uuid)'::regprocedure))=0
    or position('last_lesson is null'
      in pg_get_functiondef('private.validate_learning_document(jsonb,boolean)'::regprocedure))=0
    or position('finalScore'
      in pg_get_functiondef('hub.get_learning_certificate(uuid)'::regprocedure))=0 then
    raise exception 'Apply the ordered course delivery migration first' using errcode='55000';
  end if;
  if not (contract->'features' @> '["learning.sequence.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["learning.sequence.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
-- AI case assistance and the customer auto-resolution loop.
--
-- Staff-side assistance (summarize / draft reply / triage suggestion) is served by the
-- Hub server calling Anthropic directly; it needs no schema. This migration carries
-- only what the automated loop needs in the database:
--   * a durable system identity that authors AI thread content (never a human staffer),
--   * 'ai_assistant' as an author role for customer messages and internal notes,
--   * hub.case_ai_automation: the per-case loop state (attempts hard-capped at 2),
--   * the loop stage on the case queue, so escalation is visible to staff, and
--   * hub.record_ai_resolution_response: the customer's explicit fixed / not-fixed
--     answer, authorized and idempotent like the other case mutations.
--
-- Automation stays OFF after this migration: the server loop only runs when
-- HUB_AI_AUTOMATION_ENABLED=true and ANTHROPIC_API_KEY is configured. Applying the
-- migration alone never posts an automated message.

-- The AI assistant is a durable foreign-key identity only: it has no SMS identity,
-- no staff permission and no tenant membership, so it can never sign in, be assigned
-- a case (assignment requires a staff permission), or act through any session RPC.
insert into auth.users (id, aud, role, raw_user_meta_data, raw_app_meta_data, created_at, updated_at, is_anonymous)
values (
  'a1a00000-a1a0-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  jsonb_build_object('display_name', 'CareMetric AI Assistant'),
  jsonb_build_object('provider', 'caremetric_ai', 'providers', '[]'::jsonb),
  now(),
  now(),
  false
)
on conflict (id) do nothing;

insert into hub.profiles (id, display_name)
values ('a1a00000-a1a0-4000-8000-000000000001', 'CareMetric AI Assistant')
on conflict (id) do nothing;

alter table hub.case_messages
  drop constraint if exists case_messages_author_role_check;
alter table hub.case_messages
  add constraint case_messages_author_role_check
  check (author_role in ('customer', 'tenant_admin', 'support_agent', 'support_manager', 'platform_admin', 'ai_assistant'));

alter table private.case_notes
  drop constraint if exists case_notes_author_role_check;
alter table private.case_notes
  add constraint case_notes_author_role_check
  check (author_role in ('support_agent', 'support_manager', 'platform_admin', 'ai_assistant'));

alter table private.support_request_keys
  drop constraint if exists support_request_keys_operation_check;
alter table private.support_request_keys
  add constraint support_request_keys_operation_check
  check (operation in ('case.create', 'case.reply', 'case.ai_resolution'));

create table hub.case_ai_automation (
  case_id uuid primary key references hub.support_cases(id) on delete cascade,
  stage text not null default 'attempt_due'
    check (stage in ('attempt_due', 'awaiting_response', 'escalate_due', 'exhausted', 'resolved', 'halted')),
  attempts integer not null default 0 check (attempts between 0 and 2),
  last_attempt_at timestamptz,
  last_ai_message_id uuid references hub.case_messages(id) on delete set null,
  last_seen_customer_message_id uuid references hub.case_messages(id) on delete set null,
  last_customer_response text check (last_customer_response is null or char_length(last_customer_response) <= 5000),
  follow_up_due_at timestamptz,
  follow_up_sent_at timestamptz,
  responded_at timestamptz,
  response_source text check (response_source is null or response_source in ('portal', 'classification')),
  escalated_at timestamptz,
  halt_reason text check (halt_reason is null or char_length(halt_reason) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table hub.case_ai_automation enable row level security;

create policy case_ai_automation_read on hub.case_ai_automation for select to authenticated
using (private.can_view_case_id(case_id));

grant select on hub.case_ai_automation to authenticated;
revoke insert, update, delete on hub.case_ai_automation from anon, authenticated;

create trigger case_ai_automation_set_updated_at
  before update on hub.case_ai_automation
  for each row execute function private.set_updated_at();

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
  support_case.last_message_at,
  automation.stage as ai_stage,
  automation.attempts as ai_attempts
from hub.support_cases support_case
join hub.tenants tenant on tenant.id = support_case.tenant_id
left join hub.case_ai_automation automation on automation.case_id = support_case.id;

create or replace function hub.record_ai_resolution_response(
  p_case_id uuid,
  p_fixed boolean,
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
  v_state hub.case_ai_automation%rowtype;
  v_request private.support_request_keys%rowtype;
  v_request_hash text;
  v_inserted integer;
  v_stage text;
begin
  if v_user_id is null or not private.current_user_is_usable() then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_request_key is null then
    raise exception 'A request key is required.' using errcode = '22023';
  end if;
  if p_fixed is null then
    raise exception 'A fixed or not-fixed answer is required.' using errcode = '22023';
  end if;

  select * into v_case
  from hub.support_cases
  where id = p_case_id;
  if v_case.id is null
     or not private.can_view_case(v_case.id, v_case.tenant_id, v_case.product_id, v_case.requester_id) then
    raise exception 'Support case not found.' using errcode = '42501';
  end if;
  -- The answer belongs to the customer side of the case. Staff manage escalated
  -- cases through the normal case controls, never through this response.
  if private.has_staff_permission('case.write', v_case.product_id) then
    raise exception 'Support staff manage this case directly.' using errcode = '42501';
  end if;

  v_request_hash := encode(
    extensions.digest(
      jsonb_build_array(p_case_id, p_fixed)::text,
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
    'case.ai_resolution',
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
      and request.operation = 'case.ai_resolution'
      and request.request_key = p_request_key;

    if not found or v_request.request_hash is distinct from v_request_hash then
      raise exception 'Request key was already used with a different answer.' using errcode = '22023';
    end if;
    if v_request.completed_at is null then
      raise exception 'The earlier answer did not complete. Use a new request key.' using errcode = 'P0001';
    end if;

    select stage into v_stage
    from hub.case_ai_automation
    where case_id = p_case_id;
    return jsonb_build_object('case_id', p_case_id, 'stage', v_stage, 'replayed', true);
  end if;

  select * into v_state
  from hub.case_ai_automation
  where case_id = p_case_id
  for update;
  if v_state.case_id is null or v_state.stage <> 'awaiting_response' then
    raise exception 'No AI resolution is waiting for an answer on this case.' using errcode = 'P0001';
  end if;

  if p_fixed then
    update hub.support_cases
    set status = 'resolved'::hub.case_status,
        resolved_at = coalesce(resolved_at, now())
    where id = p_case_id;

    update hub.case_ai_automation
    set stage = 'resolved',
        responded_at = now(),
        response_source = 'portal'
    where case_id = p_case_id;
    v_stage := 'resolved';
  else
    v_stage := case when v_state.attempts >= 2 then 'escalate_due' else 'attempt_due' end;
    update hub.case_ai_automation
    set stage = v_stage,
        responded_at = now(),
        response_source = 'portal'
    where case_id = p_case_id;
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
    'case.ai_resolution_answered',
    'support_case',
    p_case_id,
    v_case.tenant_id,
    v_case.product_id,
    p_case_id,
    array['stage']
  );

  update private.support_request_keys
  set entity_id = p_case_id,
      completed_at = now()
  where actor_id = v_user_id
    and operation = 'case.ai_resolution'
    and request_key = p_request_key;

  return jsonb_build_object('case_id', p_case_id, 'stage', v_stage, 'replayed', false);
end;
$$;

revoke all on function hub.record_ai_resolution_response(uuid, boolean, uuid) from public;
grant execute on function hub.record_ai_resolution_response(uuid, boolean, uuid) to authenticated;

-- Additive deployment gate for AI case assistance and the auto-resolution loop: staff
-- AI actions are served by the Hub server, the customer answers an AI resolution
-- through hub.record_ai_resolution_response, and the case queue carries the loop
-- stage. A frontend or server that relies on these must not deploy against a backend
-- that predates the AI migration.
do $$ declare contract jsonb:=hub.get_backend_contract(); begin
  if (contract @> '{"api_version":4,"features":["support.readiness.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub support readiness release first' using errcode='55000';
  end if;
  if to_regprocedure('hub.record_ai_resolution_response(uuid,boolean,uuid)') is null
    or position('ai_stage' in pg_get_viewdef('hub.support_case_queue'::regclass)) = 0
    or position('ai_assistant' in pg_get_constraintdef(
         (select oid from pg_constraint where conname = 'case_messages_author_role_check'))) = 0 then
    raise exception 'Apply the AI case assistance migration first' using errcode='55000';
  end if;
  if not (contract->'features' @> '["support.ai-assistance.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.ai-assistance.v1"]'::jsonb);
  end if;
  if not (contract->'features' @> '["support.ai-automation.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.ai-automation.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
-- Appended migration: 20261015130000_course_creation_super_admin_only.sql
-- Owner rule (2026-10-15): only the super admin can create courses.
-- The shared learning editor gate now requires the portfolio-wide
-- platform.admin staff permission -- the same source of truth that
-- hub.authorize_platform_admin() and hub.authorize_app_admin() already
-- check -- instead of a portfolio-wide content.write grant. The governed
-- app-command flows (course creation intents, authoring intents, course
-- distribution) already required platform.admin through
-- hub.authorize_app_command(); this change makes the direct editor
-- surface match: draft creation and editing, publication, media
-- registration, source staging, and draft imports. Learner consumption
-- is deliberately untouched: the owner authored the entire existing
-- catalog, and every existing course remains visible to end users.
create or replace function private.require_learning_editor() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_learning_user();
  -- Only the platform administrator creates or edits shared courses. A
  -- content permission, even scoped portfolio-wide, no longer suffices.
  if not private.has_staff_permission('platform.admin', null) then
    raise exception 'Shared-course editor access required.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

create or replace function hub.get_learning_editor_access() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_staff_permission('platform.admin', null);
$$;
