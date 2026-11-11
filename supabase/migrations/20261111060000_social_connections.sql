-- Provider credentials are encrypted by the application before reaching PostgreSQL.
-- The encryption key lives only in the service secret store, never in this database.
create table private.social_connections (
  provider text primary key check (provider in ('meta', 'linkedin')),
  ciphertext text check (ciphertext is null or (length(ciphertext) between 40 and 90000 and ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')),
  revision uuid not null default gen_random_uuid()
);
alter table private.social_connections enable row level security;
revoke all on private.social_connections from public, anon, authenticated, service_role, hub_app_server;
insert into private.social_connections(provider) values ('meta'), ('linkedin');

create function private.social_connection_values() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return (select jsonb_agg(jsonb_build_object('provider', provider, 'ciphertext', ciphertext, 'revision', revision) order by provider)
    from private.social_connections);
end;
$$;

-- Credential and account changes commit together. Both the provider revision and
-- each setting's version must match; another tab cannot silently replace either.
create function private.save_social_connection(p_provider text, p_revision uuid, p_ciphertext text, p_settings jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor jsonb;
  current_revision uuid;
  item jsonb;
  allowed text[];
begin
  perform private.require_hub_app_server();
  actor := hub.authorize_app_command();
  allowed := case p_provider
    when 'meta' then array['social.meta_page_id','social.instagram_id','social.meta_ad_account_id']
    when 'linkedin' then array['social.linkedin_organization_id','social.linkedin_ad_account_id','social.linkedin_client_id','social.linkedin_ads_client_id']
    else null end;
  if allowed is null or p_ciphertext is null or jsonb_typeof(p_settings) is distinct from 'array'
    or jsonb_array_length(p_settings) <> cardinality(allowed) then
    raise exception 'Invalid social connection.' using errcode = '22023';
  end if;
  if (select array_agg(value ->> 'key' order by value ->> 'key') from jsonb_array_elements(p_settings))
    is distinct from (select array_agg(k order by k) from unnest(allowed) k) then
    raise exception 'Invalid social connection settings.' using errcode = '22023';
  end if;
  select revision into current_revision from private.social_connections where provider = p_provider for update;
  if current_revision is distinct from p_revision then
    raise exception 'This connection changed. Refresh and review again.' using errcode = '40001';
  end if;
  for item in select value from jsonb_array_elements(p_settings) order by value ->> 'key' loop
    perform hub.set_hub_setting(item ->> 'key', item -> 'value', (item ->> 'changedAt')::timestamptz);
  end loop;
  update private.social_connections set ciphertext = p_ciphertext, revision = gen_random_uuid() where provider = p_provider;
  insert into private.audit_events(actor_id, action, entity_type, metadata)
    values ((actor ->> 'user_id')::uuid, 'hub.social_connection', 'settings', jsonb_build_object('provider', p_provider));
end;
$$;
revoke all on function private.social_connection_values(), private.save_social_connection(text,uuid,text,jsonb)
  from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.social_connection_values(), private.save_social_connection(text,uuid,text,jsonb) to hub_app_server;
