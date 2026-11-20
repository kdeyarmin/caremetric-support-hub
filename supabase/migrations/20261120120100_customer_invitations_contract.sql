-- Declares billing.customer-invitations.v1 once customer invitations are in place (20261120120000_customer_invitations.sql): the four
-- Settings -> Billing rows exist with their kinds, the invitations table is closed to every client and server role (row level security on,
-- no privileges), and every invitation function is a security definer with a pinned empty search path that only the Hub server may run.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'billing.customer-invitations.v1';
  server_fns constant text[] := array['private.customer_invitation_price(text,text)', 'private.customer_invitation_create(uuid,jsonb,uuid,text,timestamptz)', 'private.customer_invitations_list()',
    'private.customer_invitation_find(text,text,boolean)', 'private.customer_invitation_sent(uuid,text)', 'private.customer_invitation_tenant(uuid)',
    'private.customer_invitation_progress(uuid,text,jsonb)', 'private.customer_invitation_claim(uuid,text,text,text)',
    'private.customer_invitation_owner(uuid,uuid,text,integer,text,timestamptz)'];
  internal_fns constant text[] := array['private.customer_invitation_link(uuid,text,text,uuid,text)',
    'private.customer_invitation_view(private.customer_invitations)', 'private.customer_invitation_internal(private.customer_invitations)'];
  fn text;
begin
  if (contract @> '{"api_version":4,"features":["billing.platform.v1","platform.settings.v1"]}'::jsonb) is not true then
    raise exception 'Apply the platform billing and settings migrations first' using errcode = '55000';
  end if;
  if (select count(*) from private.hub_settings
      where (key, kind) in (('billing.invite_carebase_signup', 'text'), ('billing.invite_breathe_signup', 'text'),
                            ('billing.invite_intel_signup', 'text'), ('billing.invite_days', 'number'))) <> 4 then
    raise exception 'The four invitation settings must have rows' using errcode = '55000';
  end if;
  if not coalesce((select relrowsecurity from pg_class where oid = 'private.customer_invitations'::regclass), false)
     or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
                where has_table_privilege(r, 'private.customer_invitations', 'select,insert,update,delete')) then
    raise exception 'Customer invitations must be closed to every client and server role' using errcode = '55000';
  end if;
  foreach fn in array server_fns loop
    if to_regprocedure(fn) is null or not has_function_privilege('hub_app_server', fn, 'execute')
       or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute'))
       or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0
       or not coalesce((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = fn::regprocedure), false) then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  foreach fn in array internal_fns loop
    if to_regprocedure(fn) is null
       or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r where has_function_privilege(r, fn, 'execute'))
       or not coalesce((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = fn::regprocedure), false) then
      raise exception '% is used only inside the invitation functions', fn using errcode = '55000';
    end if;
  end loop;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
