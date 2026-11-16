-- A list setting may hold up to 60 texts. Settings → Customer growth → "States to prospect in" accepts up to 60 state codes on
-- the Settings page (server/hub-settings.mjs), but the database allowed 20, so saving a 21st state was refused with "That value
-- does not fit this setting." Every other list setting already accepts 20 or fewer on the page, so they are unaffected.
-- Widening only: every value already stored still fits, so the check constraint that uses this function needs no revalidation.
create or replace function private.hub_setting_value_ok(p_kind text, p_value jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p_value is null or case p_kind
    when 'flag' then jsonb_typeof(p_value) = 'boolean'
    when 'text' then jsonb_typeof(p_value) = 'string' and char_length(p_value #>> '{}') between 1 and 1000
    when 'number' then jsonb_typeof(p_value) = 'number' and abs((p_value #>> '{}')::numeric) <= 1000000000
    when 'list' then jsonb_typeof(p_value) = 'array' and jsonb_array_length(p_value) between 1 and 60
      and not exists (select 1 from jsonb_array_elements(p_value) item
                      where jsonb_typeof(item) <> 'string' or char_length(item #>> '{}') not between 1 and 1000)
    else false end;
$$;

revoke all on function private.hub_setting_value_ok(text, jsonb) from public, anon, authenticated, service_role, hub_app_server;
