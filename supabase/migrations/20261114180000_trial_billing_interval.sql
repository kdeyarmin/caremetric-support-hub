-- An explicit self-service choice must select exactly one published price.
-- Existing callers without an interval keep their original lookup contract.
alter function private.billing_lookup(text,text) rename to billing_lookup_before_trial_interval;
revoke all on function private.billing_lookup_before_trial_interval(text,text) from public,anon,authenticated,service_role,hub_app_server;

create function private.billing_lookup(p_kind text,p_id text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare prices jsonb;
begin
  perform private.require_hub_app_server();
  if p_kind <> 'trial_price_interval' then
    return private.billing_lookup_before_trial_interval(p_kind,p_id);
  end if;
  if split_part(p_id,':',3) not in ('month','year') then
    raise exception 'Choose monthly or annual billing.' using errcode='22023';
  end if;
  select jsonb_agg(jsonb_build_object('price',r.stripe_price_id,'product',p.stripe_product_id)) into prices
    from private.billing_prices r
    join private.billing_products p on p.stripe_product_id=r.stripe_product_id
    join hub.products h on h.id=p.product_id
    where h.slug=split_part(p_id,':',1) and p.entitlement_key=split_part(p_id,':',2)
      and p.active and r.active and r.tenant_id is null and r.type='recurring'
      and r.recurring_interval=split_part(p_id,':',3) and r.interval_count=1
      and r.currency='usd' and r.unit_amount>0 and p.kind='plan';
  if jsonb_array_length(prices) is distinct from 1 then
    raise exception 'Exactly one published trial conversion price is required.' using errcode='22023';
  end if;
  return prices->0;
end; $$;
revoke all on function private.billing_lookup(text,text) from public,anon,authenticated,service_role;
grant execute on function private.billing_lookup(text,text) to hub_app_server;
