-- Declares billing.trial-cards.v1 once Stripe's trial card answers can be kept (20261116020000_billing_trial_cards.sql): the table is
-- closed to every role with row-level security on, and recording and reading are guarded Hub server functions. The Hub server keeps
-- and reads confirmations in the database only when the feature is declared; before that it keeps them in memory alone.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'billing.trial-cards.v1';
  fn text;
  r text;
begin
  if (contract @> '{"api_version":4,"features":["billing.platform.v1"]}'::jsonb) is not true then
    raise exception 'Apply the platform billing migrations first' using errcode = '55000';
  end if;
  if to_regclass('private.billing_trial_cards') is null
     or not (select relrowsecurity from pg_class where oid = 'private.billing_trial_cards'::regclass) then
    raise exception 'The trial card table must exist with row-level security' using errcode = '55000';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_table_privilege(r, 'private.billing_trial_cards', 'select, insert, update, delete') then
      raise exception 'The trial card table must be closed to %', r using errcode = '55000';
    end if;
  end loop;
  foreach fn in array array['private.billing_trial_card_record(uuid,text[],boolean)', 'private.billing_trial_card_confirmed(uuid,text[])'] loop
    if to_regprocedure(fn) is null
       or not exists (select 1 from pg_proc where oid = fn::regprocedure and prosecdef and proconfig @> array['search_path=""']
         and prosrc like '%require_hub_app_server%')
       or not has_function_privilege('hub_app_server', fn, 'execute') then
      raise exception '% must be a guarded Hub server function', fn using errcode = '55000';
    end if;
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, fn, 'execute') then raise exception '% exposed to %', fn, r using errcode = '55000'; end if;
    end loop;
  end loop;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
