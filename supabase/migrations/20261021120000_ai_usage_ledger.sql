-- AI usage ledger: one row per Anthropic call the Hub makes, attributed to the
-- support case it served and, through that case, to the application and the
-- customer tenant. The platform administrator reads the roll-up in the control
-- center (hub.get_ai_usage_summary). Rows carry provenance only — the feature,
-- model, outcome, token counts and latency — never prompt or reply content.
--
-- Writes come only from the Hub server role (hub_app_server), the same closed
-- boundary as the AI automation operations in 20261020120000. No browser,
-- service or server role may read or write the table directly; the summary is a
-- security definer read behind the current administrator session.

create table private.ai_usage (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  case_id uuid references hub.support_cases(id) on delete set null,
  tenant_id uuid references hub.tenants(id) on delete set null,
  product_id uuid references hub.products(id) on delete set null,
  actor text not null check (actor in ('staff', 'automation')),
  feature text not null check (feature ~ '^[a-z_]{1,60}$'),
  model text not null check (model ~ '^[a-z0-9.-]{1,80}$'),
  outcome text not null check (outcome in ('completed', 'failed')),
  input_tokens integer check (input_tokens is null or input_tokens between 0 and 100000000),
  output_tokens integer check (output_tokens is null or output_tokens between 0 and 100000000),
  latency_ms integer check (latency_ms is null or latency_ms between 0 and 86400000)
);
create index ai_usage_occurred_at_idx on private.ai_usage (occurred_at desc);
create index ai_usage_product_tenant_idx on private.ai_usage (product_id, tenant_id, occurred_at desc);
alter table private.ai_usage enable row level security;
revoke all on private.ai_usage from public, anon, authenticated, service_role, hub_app_server;

-- The Hub server records a call after it completes or fails. The tenant and
-- application are resolved here from the case so the server never asserts them;
-- a call for an unknown case is kept unattributed rather than dropped.
create function private.record_ai_usage(
  p_case_id uuid, p_actor text, p_feature text, p_model text, p_outcome text,
  p_input_tokens integer, p_output_tokens integer, p_latency_ms integer
) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_case hub.support_cases%rowtype; v_id uuid;
begin
  if session_user <> 'hub_app_server' then
    raise exception 'Application server required.' using errcode = '42501';
  end if;
  if p_case_id is not null then
    select * into v_case from hub.support_cases where id = p_case_id;
  end if;
  insert into private.ai_usage (case_id, tenant_id, product_id, actor, feature, model, outcome, input_tokens, output_tokens, latency_ms)
  values (v_case.id, v_case.tenant_id, v_case.product_id, p_actor, p_feature, p_model, p_outcome, p_input_tokens, p_output_tokens, p_latency_ms)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function private.record_ai_usage(uuid,text,text,text,text,integer,integer,integer) from public, anon, authenticated, service_role;
grant execute on function private.record_ai_usage(uuid,text,text,text,text,integer,integer,integer) to hub_app_server;

-- Calls, failures and tokens for the last p_days days: portfolio totals, every
-- current application (zero when nothing was recorded for it), and within each
-- application every customer tenant that used AI assistance. Platform
-- administrator only.
create function hub.get_ai_usage_summary(p_days integer default 30) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare since timestamptz; result jsonb;
begin
  perform hub.authorize_app_admin();
  if p_days is null or p_days < 1 or p_days > 365 then
    raise exception 'Choose between 1 and 365 days.';
  end if;
  since := now() - make_interval(days => p_days);
  with usage as (
    select * from private.ai_usage where occurred_at >= since
  ), by_product as (
    select product_id, count(*) as calls, count(*) filter (where outcome = 'failed') as failed_calls,
      count(*) filter (where actor = 'staff') as staff_calls, count(*) filter (where actor = 'automation') as automation_calls,
      coalesce(sum(input_tokens), 0) as input_tokens, coalesce(sum(output_tokens), 0) as output_tokens
    from usage where product_id is not null group by product_id
  ), by_tenant as (
    select product_id, tenant_id, count(*) as calls, count(*) filter (where outcome = 'failed') as failed_calls,
      coalesce(sum(input_tokens), 0) as input_tokens, coalesce(sum(output_tokens), 0) as output_tokens
    from usage where product_id is not null and tenant_id is not null group by product_id, tenant_id
  ), by_feature as (
    select feature, count(*) as calls, coalesce(sum(input_tokens), 0) as input_tokens, coalesce(sum(output_tokens), 0) as output_tokens
    from usage group by feature
  )
  select jsonb_build_object(
    'days', p_days, 'since', since, 'loadedAt', now(),
    'totals', (select jsonb_build_object(
      'calls', count(*), 'failedCalls', count(*) filter (where outcome = 'failed'),
      'staffCalls', count(*) filter (where actor = 'staff'), 'automationCalls', count(*) filter (where actor = 'automation'),
      'inputTokens', coalesce(sum(input_tokens), 0), 'outputTokens', coalesce(sum(output_tokens), 0)) from usage),
    'unattributedCalls', (select count(*) from usage where product_id is null),
    'products', (select coalesce(jsonb_agg(jsonb_build_object(
        'productId', p.id, 'slug', p.slug, 'name', p.name,
        'calls', coalesce(bp.calls, 0), 'failedCalls', coalesce(bp.failed_calls, 0),
        'staffCalls', coalesce(bp.staff_calls, 0), 'automationCalls', coalesce(bp.automation_calls, 0),
        'inputTokens', coalesce(bp.input_tokens, 0), 'outputTokens', coalesce(bp.output_tokens, 0),
        'tenants', (select coalesce(jsonb_agg(jsonb_build_object(
            'tenantId', t.id, 'name', t.name, 'calls', bt.calls, 'failedCalls', bt.failed_calls,
            'inputTokens', bt.input_tokens, 'outputTokens', bt.output_tokens) order by bt.calls desc, t.name), '[]'::jsonb)
          from by_tenant bt join hub.tenants t on t.id = bt.tenant_id where bt.product_id = p.id)
      ) order by p.name), '[]'::jsonb)
      from hub.products p left join by_product bp on bp.product_id = p.id where p.status::text <> 'retired'),
    'features', (select coalesce(jsonb_agg(jsonb_build_object(
        'feature', feature, 'calls', calls, 'inputTokens', input_tokens, 'outputTokens', output_tokens) order by calls desc, feature), '[]'::jsonb)
      from by_feature)
  ) into result;
  return result;
end;
$$;
revoke all on function hub.get_ai_usage_summary(integer) from public, anon;
grant execute on function hub.get_ai_usage_summary(integer) to authenticated;
