-- Which products the AI team markets to new customers, switched by the owner on the AI team page. The owner decided (2026-11-08)
-- that CareBase stays in a pilot with a few facilities they choose, that the team markets CareMetric Intel only, and that turning
-- marketing on and off belongs in the Hub, not in a server setting. So:
--
-- - one row per product the team could market (CareMetric Intel, CareBase, Healthcare Advisors), each switched on or off. Intel
--   starts on; CareBase and Healthcare Advisors start off;
-- - the owner reads and switches them (hub.get_marketing_products, hub.set_marketing_product). A stale screen is refused and every
--   change is audited;
-- - the Hub server reads the list (private.marketed_products) when each marketing task starts, so a change applies to the next run
--   without a restart. Prospecting, cold email, social posts and ads, help-center articles, outreach drafts and the Sales Executive's
--   answers follow it; customers' onboarding and support do not depend on it.
--
-- Boundary (the same closed shape as the rest of the AI team): the table has row level security and no privilege for any browser,
-- service or server role; the server read is a security definer with a pinned empty search path that refuses every session user but
-- hub_app_server; the owner operations authorize the owner's session themselves; the helper is executable by no role.

create table private.marketing_products (
  product text primary key check (product in ('caremetric-intel', 'carebase', 'advisors')),
  label text not null check (char_length(btrim(label)) between 3 and 80),
  -- What switching it on means, shown beside the switch.
  description text not null check (char_length(btrim(description)) between 10 and 300),
  marketed boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid
);
alter table private.marketing_products enable row level security;
revoke all on private.marketing_products from public, anon, authenticated, service_role, hub_app_server;

insert into private.marketing_products (product, label, description, marketed) values
  ('caremetric-intel', 'CareMetric Intel',
    'Prospecting and cold email to home health and hospice agencies, social posts and ads, help-center articles and outreach drafts.', true),
  ('carebase', 'CareMetric CareBase',
    'Prospecting and cold email to personal care homes and ALFs, social posts and ads, help-center articles and outreach drafts. Off while CareBase is in its pilot.', false),
  ('advisors', 'CareMetric Healthcare Advisors',
    'Help-center articles and partnership pitches for the consulting service.', false)
on conflict (product) do nothing;

create function private.marketing_product_json(p_row private.marketing_products) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('product', p_row.product, 'label', p_row.label, 'description', p_row.description, 'marketed', p_row.marketed,
    'changedAt', p_row.changed_at);
$$;

-- Server: the products marketed right now, as a JSON array of their keys.
create function private.marketed_products() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return (select coalesce(jsonb_agg(m.product order by m.product), '[]'::jsonb) from private.marketing_products m where m.marketed);
end;
$$;

-- Owner: every product with its switch, in a fixed order (Intel, CareBase, Healthcare Advisors).
create function hub.get_marketing_products() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform hub.authorize_app_admin();
  return (select coalesce(jsonb_agg(private.marketing_product_json(m)
      order by array_position(array['caremetric-intel', 'carebase', 'advisors'], m.product)), '[]'::jsonb)
    from private.marketing_products m);
end;
$$;

-- Owner: switch marketing of one product on or off. A stale screen is refused.
create function hub.set_marketing_product(p_product text, p_marketed boolean, p_expected_changed_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_row private.marketing_products%rowtype;
begin
  v_actor := hub.authorize_app_command();
  if p_marketed is null then
    raise exception 'Choose on or off.' using errcode = '22023';
  end if;
  -- Locked before the version is compared, so of two changes made from the same screen the second is refused instead of applied.
  select * into v_row from private.marketing_products where product = p_product for update;
  if not found then
    raise exception 'Unknown product.' using errcode = 'P0002';
  end if;
  if v_row.changed_at is distinct from p_expected_changed_at then
    raise exception 'This setting changed. Refresh and review again.' using errcode = '40001';
  end if;
  update private.marketing_products set marketed = p_marketed, changed_at = now(), changed_by = (v_actor ->> 'user_id')::uuid
  where product = p_product returning * into v_row;
  insert into private.audit_events (actor_id, action, entity_type, metadata)
  values ((v_actor ->> 'user_id')::uuid, 'agent.marketing', 'agent', jsonb_build_object('product', p_product, 'marketed', p_marketed));
  return private.marketing_product_json(v_row);
end;
$$;

revoke all on function private.marketing_product_json(private.marketing_products), private.marketed_products()
  from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.marketed_products() to hub_app_server;

revoke all on function hub.get_marketing_products(), hub.set_marketing_product(text, boolean, timestamptz) from public, anon, service_role;
grant execute on function hub.get_marketing_products(), hub.set_marketing_product(text, boolean, timestamptz) to authenticated;
