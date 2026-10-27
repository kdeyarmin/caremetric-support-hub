-- Deployment gate for Hub-owned platform billing.
-- Declares billing.platform.v1 only when every mirror table is RLS-enabled
-- with no direct privileges, the write path is reachable by the Hub server
-- role alone, administrator reads require the current administrator session
-- and tenant changes require the command session. Retires the CareBase-relayed
-- billing.portal.v1 and billing.checkout.v1 features and the manual pricing
-- feature platform.admin.tenants.v1, preserving every other feature and its order.
do $$
declare contract jsonb:=hub.get_backend_contract(); relation text; signature text; role_name text; features jsonb;
begin
  if (contract @> '{"api_version":4,"features":["app.sms.v1","platform.admin.read.v1","platform.admin.command.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub SMS and administrator foundations first' using errcode='55000';
  end if;
  if to_regclass('private.tenant_subscriptions') is not null or to_regclass('private.billing_portal_intents') is not null
    or to_regclass('private.billing_checkout_intents') is not null or to_regprocedure('hub.save_tenant_subscription(uuid,uuid,jsonb,integer)') is not null then
    raise exception 'Retire the manual pricing records and billing relays first' using errcode='55000';
  end if;
  foreach relation in array array['private.billing_settings','private.billing_customers','private.billing_products','private.billing_prices',
    'private.billing_subscriptions','private.billing_subscription_items','private.billing_coupons','private.billing_promotion_codes',
    'private.billing_invoices','private.billing_webhook_events','private.billing_app_keys','private.billing_account_links','private.billing_usage_reports'] loop
    if to_regclass(relation) is null or not (select relrowsecurity from pg_class where oid=to_regclass(relation)) then
      raise exception 'Billing mirror tables must exist with row level security' using errcode='55000';
    end if;
    foreach role_name in array array['anon','authenticated','service_role','hub_app_server'] loop
      if has_table_privilege(role_name,relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') then
        raise exception 'Billing mirror tables must remain closed' using errcode='55000';
      end if;
    end loop;
  end loop;
  foreach signature in array array['private.billing_sync(text,jsonb,timestamptz)','private.billing_record_event(text,text,boolean,text,timestamptz,text)',
    'private.billing_set_account(text,boolean)','private.billing_lock(text,text,integer)','private.billing_context(uuid)',
    'private.billing_audit(uuid,text,uuid,uuid,jsonb)','private.billing_issue_app_key(uuid,uuid,text,text)','private.billing_revoke_app_key(uuid,uuid)',
    'private.billing_authenticate_app(text)','private.billing_app_entitlements(uuid,text)','private.billing_app_tenant(uuid,text,text)','private.billing_forget_invoice(text)','private.billing_usage_targets(uuid,text,text)',
    'private.billing_record_usage(uuid,uuid,text,integer,uuid,text,integer)','private.billing_link_account(uuid,uuid,uuid,text,integer)',
    'private.billing_unlink_account(uuid,uuid,uuid,integer)'] loop
    if to_regprocedure(signature) is null or not has_function_privilege('hub_app_server',signature,'EXECUTE')
      or has_function_privilege('anon',signature,'EXECUTE') or has_function_privilege('authenticated',signature,'EXECUTE')
      or has_function_privilege('service_role',signature,'EXECUTE')
      or position('private.require_hub_app_server()' in pg_get_functiondef(signature::regprocedure))=0 then
      raise exception 'Billing writes must be reachable by the Hub server role alone' using errcode='55000';
    end if;
  end loop;
  foreach signature in array array['private.billing_entitlements(uuid,uuid)','private.billing_resolve_account(uuid,text)','private.billing_issuer(uuid)'] loop
    if to_regprocedure(signature) is null or has_function_privilege('hub_app_server',signature,'EXECUTE')
      or has_function_privilege('authenticated',signature,'EXECUTE') or has_function_privilege('anon',signature,'EXECUTE') then
      raise exception 'Billing helpers must remain private' using errcode='55000';
    end if;
  end loop;
  foreach signature in array array['hub.billing_workspace()','hub.billing_customer(uuid)'] loop
    if to_regprocedure(signature) is null or has_function_privilege('anon',signature,'EXECUTE')
      or not has_function_privilege('authenticated',signature,'EXECUTE')
      or position('hub.authorize_app_admin()' in pg_get_functiondef(signature::regprocedure))=0 then
      raise exception 'Billing reads require the current administrator session' using errcode='55000';
    end if;
  end loop;
  foreach signature in array array['hub.create_tenant(jsonb)','hub.save_tenant(uuid,jsonb,timestamptz)'] loop
    if to_regprocedure(signature) is null or has_function_privilege('anon',signature,'EXECUTE')
      or not has_function_privilege('authenticated',signature,'EXECUTE')
      or position('hub.authorize_app_command()' in pg_get_functiondef(signature::regprocedure))=0 then
      raise exception 'Tenant changes require the current administrator command session' using errcode='55000';
    end if;
  end loop;
  foreach signature in array array['hub.my_billing()','hub.authorize_tenant_billing(uuid)'] loop
    if to_regprocedure(signature) is null or has_function_privilege('anon',signature,'EXECUTE')
      or not has_function_privilege('authenticated',signature,'EXECUTE')
      or position('private.current_app_session_verified()' in pg_get_functiondef(signature::regprocedure))=0
      or position('tenant_admin' in pg_get_functiondef(signature::regprocedure))=0 then
      raise exception 'Customer billing requires a verified tenant administrator session' using errcode='55000';
    end if;
  end loop;
  select coalesce(jsonb_agg(f order by ordinality),'[]'::jsonb) into features
    from jsonb_array_elements_text(contract->'features') with ordinality as t(f,ordinality)
    where f not in ('billing.portal.v1','billing.checkout.v1','platform.admin.tenants.v1');
  if not (features @> '["billing.platform.v1"]'::jsonb) then features:=features||'["billing.platform.v1"]'::jsonb; end if;
  contract:=jsonb_set(contract,'{features}',features);
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
