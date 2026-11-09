-- The Hub's settings: switches and values the owner changes on the Settings page (/admin/settings) instead of in Railway variables.
-- The owner decided (2026-11-09) that anything that is not a secret belongs in the Hub, not in a server variable: features are turned
-- on and off here, and addresses, links, account ids and limits are typed here. Only secrets (API keys, tokens, signing keys) and the
-- service's own wiring stay in Railway. So:
--
-- - one row per setting the Hub knows, each with its kind (an on/off switch, a text, a number or a list of texts) and its value. A
--   null value means "not set": the Hub server uses the setting's default. Each kind's value has a fixed JSON shape and a size limit;
--   what a value means (an email address, an https link, an account id) is checked by the server before it is saved;
-- - the owner reads every setting and changes one (hub.get_hub_settings, hub.set_hub_setting). A stale screen is refused and every
--   change is audited;
-- - the Hub server reads the values (private.hub_settings_values) at start and every 30 seconds, so a change applies within a minute
--   without a restart;
-- - the Hub server copies the value of each Railway variable a setting replaces, once, into a setting nobody has set yet
--   (private.hub_settings_import). After that the variable is never read again and can be deleted. A setting the owner has saved,
--   including one reset to its default, is never overwritten.
--
-- Boundary (the same closed shape as the AI team's switches): the table has row level security and no privilege for any browser,
-- service or server role; the server operations are security definers with a pinned empty search path that refuse every session user
-- but hub_app_server; the owner operations authorize the owner's session themselves; the helpers are executable by no role.

create table private.hub_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,30}\.[a-z][a-z0-9_]{1,60}$'),
  kind text not null check (kind in ('flag', 'text', 'number', 'list')),
  value jsonb,
  -- The Railway variable this value was copied from, when it was copied rather than saved by the owner.
  imported_from text check (imported_from ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  changed_at timestamptz not null default now(),
  changed_by uuid
);
alter table private.hub_settings enable row level security;
revoke all on private.hub_settings from public, anon, authenticated, service_role, hub_app_server;

-- Whether a value has its kind's shape: a boolean, a text of at most 1000 characters, a number of at most a billion, or a list of at
-- most 20 texts of at most 1000 characters each. Null (not set) always fits.
create function private.hub_setting_value_ok(p_kind text, p_value jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p_value is null or case p_kind
    when 'flag' then jsonb_typeof(p_value) = 'boolean'
    when 'text' then jsonb_typeof(p_value) = 'string' and char_length(p_value #>> '{}') between 1 and 1000
    when 'number' then jsonb_typeof(p_value) = 'number' and abs((p_value #>> '{}')::numeric) <= 1000000000
    when 'list' then jsonb_typeof(p_value) = 'array' and jsonb_array_length(p_value) between 1 and 20
      and not exists (select 1 from jsonb_array_elements(p_value) item
                      where jsonb_typeof(item) <> 'string' or char_length(item #>> '{}') not between 1 and 1000)
    else false end;
$$;
alter table private.hub_settings add constraint hub_settings_value_shape check (private.hub_setting_value_ok(kind, value));

-- Every setting the Hub knows, not set. server/hub-settings.mjs holds the same keys with what each means, its default and the variable
-- it replaces; server/hub-settings.test.mjs keeps the two lists equal.
insert into private.hub_settings (key, kind) values
  ('agents.enabled', 'flag'),
  ('agents.customer_text_to_ai', 'flag'),
  ('agents.owner_email', 'text'),
  ('support.ai_automation', 'flag'),
  ('support.ai_draft_tier', 'text'),
  ('support.ai_follow_up_hours', 'number'),
  ('support.chat', 'flag'),
  ('email.support_from', 'text'),
  ('email.reply_to', 'text'),
  ('email.postal_address', 'text'),
  ('email.growth_from', 'text'),
  ('email.growth_from_name', 'text'),
  ('sms.messaging_service_sid', 'text'),
  ('sms.from_number', 'text'),
  ('growth.send', 'flag'),
  ('billing.customer_purchasing', 'flag'),
  ('billing.intel_price_sync', 'flag'),
  ('billing.portal_configuration', 'text'),
  ('learning.legacy_distribution_opt_in', 'flag'),
  ('social.meta_page_id', 'text'),
  ('social.instagram_id', 'text'),
  ('social.meta_ad_account_id', 'text'),
  ('social.meta_graph_version', 'text'),
  ('social.linkedin_organization_id', 'text'),
  ('social.linkedin_ad_account_id', 'text'),
  ('social.linkedin_client_id', 'text'),
  ('social.linkedin_ads_client_id', 'text'),
  ('social.linkedin_api_version', 'text'),
  ('social.image_urls', 'list'),
  ('social.target_cost_cents', 'number'),
  ('social.max_daily_budget_cents', 'number'),
  ('seo.search_console_sites', 'list')
on conflict (key) do nothing;

create function private.hub_setting_json(p_row private.hub_settings) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('key', p_row.key, 'kind', p_row.kind, 'value', p_row.value, 'importedFrom', p_row.imported_from,
    'changedAt', p_row.changed_at, 'savedInHub', p_row.changed_by is not null);
$$;

-- Server: every setting that has a value, as one JSON object of key to value.
create function private.hub_settings_values() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return (select coalesce(jsonb_object_agg(s.key, s.value), '{}'::jsonb) from private.hub_settings s where s.value is not null);
end;
$$;

-- Server: copy Railway values into settings nobody has set, once. `p_values` is an object of key to { "value": …, "from": "VARIABLE" }.
-- An unknown key, a setting already set or saved, and a value without its kind's shape are skipped. Returns the keys copied.
create function private.hub_settings_import(p_values jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_key text;
  v_item jsonb;
  v_done text[] := array[]::text[];
begin
  perform private.require_hub_app_server();
  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    raise exception 'Invalid settings.' using errcode = '22023';
  end if;
  for v_key, v_item in select key, value from jsonb_each(p_values) loop
    continue when jsonb_typeof(v_item) <> 'object' or coalesce(v_item ->> 'from', '') !~ '^[A-Z][A-Z0-9_]{2,80}$';
    update private.hub_settings s set value = v_item -> 'value', imported_from = v_item ->> 'from', changed_at = now()
    where s.key = v_key and s.value is null and s.imported_from is null and s.changed_by is null
      and private.hub_setting_value_ok(s.kind, v_item -> 'value') and v_item -> 'value' <> 'null'::jsonb;
    if found then v_done := v_done || v_key; end if;
  end loop;
  if cardinality(v_done) > 0 then
    insert into private.audit_events (actor_id, action, entity_type, metadata)
    values (null, 'hub.settings.import', 'settings', jsonb_build_object('keys', to_jsonb(v_done)));
  end if;
  return to_jsonb(v_done);
end;
$$;

-- Owner: every setting, in key order.
create function hub.get_hub_settings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform hub.authorize_app_admin();
  return (select coalesce(jsonb_agg(private.hub_setting_json(s) order by s.key), '[]'::jsonb) from private.hub_settings s);
end;
$$;

-- Owner: change one setting, or clear it (null) to use its default. A stale screen is refused.
create function hub.set_hub_setting(p_key text, p_value jsonb, p_expected_changed_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_value jsonb := nullif(p_value, 'null'::jsonb);
  v_row private.hub_settings%rowtype;
begin
  v_actor := hub.authorize_app_command();
  -- Locked before the version is compared, so of two changes made from the same screen the second is refused instead of applied.
  select * into v_row from private.hub_settings where key = p_key for update;
  if not found then
    raise exception 'Unknown setting.' using errcode = 'P0002';
  end if;
  if v_row.changed_at is distinct from p_expected_changed_at then
    raise exception 'This setting changed. Refresh and review again.' using errcode = '40001';
  end if;
  if not private.hub_setting_value_ok(v_row.kind, v_value) then
    raise exception 'That value does not fit this setting.' using errcode = '22023';
  end if;
  update private.hub_settings set value = v_value, imported_from = null, changed_at = now(), changed_by = (v_actor ->> 'user_id')::uuid
  where key = p_key returning * into v_row;
  -- The key and, for a switch, whether it is on. Addresses and other values are not copied into the audit trail.
  insert into private.audit_events (actor_id, action, entity_type, metadata)
  values ((v_actor ->> 'user_id')::uuid, 'hub.setting', 'settings',
    jsonb_build_object('key', p_key, 'set', v_value is not null) || case when v_row.kind = 'flag' and v_value is not null then jsonb_build_object('on', v_value) else '{}'::jsonb end);
  return private.hub_setting_json(v_row);
end;
$$;

revoke all on function private.hub_setting_value_ok(text, jsonb), private.hub_setting_json(private.hub_settings),
  private.hub_settings_values(), private.hub_settings_import(jsonb)
  from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.hub_settings_values(), private.hub_settings_import(jsonb) to hub_app_server;

revoke all on function hub.get_hub_settings(), hub.set_hub_setting(text, jsonb, timestamptz) from public, anon, service_role;
grant execute on function hub.get_hub_settings(), hub.set_hub_setting(text, jsonb, timestamptz) to authenticated;
