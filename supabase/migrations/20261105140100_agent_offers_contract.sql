-- Additive deployment gate for offers from the owner's menu. Declaring the feature changes no behavior by itself (an offer is made
-- without the owner's approval only when the "offers" autonomy step adds offer.apply to the Account Manager's list): it states that the
-- menu and the record of offers made exist with row level security and are closed to every browser, service and server role; that
-- offer.apply is a checked action kind; that the four server operations are security definers with a pinned empty search path
-- executable by the Hub server role alone, and that the one that makes an offer re-checks the Account Manager's trust (active, on Act,
-- holding its row) for an offer nobody approved, holds the menu row while it counts the cap, keeps the once-per-account rule and re-checks
-- the offer's window; that an offer whose action ends unsettled is settled by a trigger on the action, so a refusal gives its place back; that the
-- owner operations authorize the owner's session themselves and are executable by signed-in sessions only; that the helpers are executable
-- by no role; and that the Account Manager's daily schedule exists. Every test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  signature text;
  role_name text;
  definition text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.v1","platform.agents.hardening.v1","platform.agents.lifecycle.v1","platform.agents.autonomy.v1","billing.platform.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI team control plane, its hardening, the customer emails, autonomy steps and platform billing first' using errcode = '55000';
  end if;

  foreach signature in array array['private.agent_offer_menu', 'private.agent_offer_uses'] loop
    if to_regclass(signature) is null or not coalesce((select relrowsecurity from pg_class where oid = to_regclass(signature)), false) then
      raise exception 'The offer menu and the record of offers must exist with row level security' using errcode = '55000';
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
      if has_table_privilege(role_name, signature, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
        or has_any_column_privilege(role_name, signature, 'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'The offer tables must remain closed to every browser, service and server role' using errcode = '55000';
      end if;
    end loop;
  end loop;
  if to_regclass('private.agent_offer_uses_once') is null then
    raise exception 'An offer must be made at most once per account' using errcode = '55000';
  end if;

  if not coalesce((select position('''offer.apply''' in pg_get_constraintdef(oid)) > 0 from pg_constraint
                   where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_kind_check'), false)
    or not coalesce((select position('billing_account' in pg_get_constraintdef(oid)) > 0 and position('subscription' in pg_get_constraintdef(oid)) > 0
                     from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_offer_apply_check'), false) then
    raise exception 'Offers must be a checked action kind aimed at a billing account' using errcode = '55000';
  end if;

  foreach signature in array array['private.agent_offer_candidates(integer)', 'private.agent_offer_begin(uuid,integer)', 'private.agent_offer_settle(uuid,text)',
    'private.agent_offer_request(uuid,integer,jsonb)'] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
      or position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
      raise exception 'Offer server operations must be security definer with a pinned search path, executable by the Hub server only' using errcode = '55000';
    end if;
  end loop;
  definition := pg_get_functiondef(to_regprocedure('private.agent_offer_begin(uuid,integer)'));
  if position('decided_by is null' in definition) = 0 or position('offer.apply' in definition) = 0
    or position('v_agent.status is distinct from ''active''' in definition) = 0
    or position('v_agent.autonomy is distinct from ''act''' in definition) = 0
    or position('where key = v_action.agent_key for share' in definition) = 0
    or position('where key = v_action.input ->> ''offer'' for update' in definition) = 0
    or position('monthly_cap' in definition) = 0 or position('already_offered' in definition) = 0
    or position('make_interval(days => v_offer.window_days)' in definition) = 0 then
    raise exception 'Making an offer must re-check the Account Manager''s trust and hold the menu row while it counts the cap' using errcode = '55000';
  end if;

  foreach signature in array array['hub.get_agent_offers()', 'hub.set_agent_offer(text,boolean,integer,timestamp with time zone)',
    'hub.add_agent_offer(text,text,integer,text,text[],integer,integer)'] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
      or (position('hub.authorize_app_admin()' in pg_get_functiondef(to_regprocedure(signature))) = 0
        and position('hub.authorize_app_command()' in pg_get_functiondef(to_regprocedure(signature))) = 0) then
      raise exception 'Offer owner operations must authorize the owner''s session and be executable by signed-in sessions only' using errcode = '55000';
    end if;
  end loop;
  foreach signature in array array['hub.set_agent_offer(text,boolean,integer,timestamp with time zone)', 'hub.add_agent_offer(text,text,integer,text,text[],integer,integer)'] loop
    if position('hub.authorize_app_command()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
      raise exception 'Changing the offer menu must need a current administrator session' using errcode = '55000';
    end if;
  end loop;

  foreach signature in array array[
    'private.agent_offer_month_start()', 'private.agent_offer_use_json(private.agent_offer_uses,text)',
    'private.agent_offer_menu_json(private.agent_offer_menu)', 'private.agent_offer_coupon_usable(text)',
    'private.agent_offer_record(uuid,text)', 'private.agent_offer_settle_on_completion()'
  ] loop
    if to_regprocedure(signature) is null
      or not coalesce((select coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false) then
      raise exception 'The offer helpers must exist with a pinned search path' using errcode = '55000';
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
      if has_function_privilege(role_name, signature, 'EXECUTE') then
        raise exception 'The offer helpers must stay internal to their operations' using errcode = '55000';
      end if;
    end loop;
  end loop;

  if not exists (select 1 from pg_trigger where tgrelid = 'private.agent_actions'::regclass and tgname = 'agent_offer_settle_on_completion'
                   and tgenabled <> 'D' and tgfoid = to_regprocedure('private.agent_offer_settle_on_completion()'))
    or position('''offer_refused''' in pg_get_functiondef(to_regprocedure('private.agent_offer_settle_on_completion()'))) = 0
    or position('private.agent_offer_record(' in pg_get_functiondef(to_regprocedure('private.agent_offer_settle(uuid,text)'))) = 0 then
    raise exception 'An offer whose action ends unsettled must be settled from how its action ended' using errcode = '55000';
  end if;

  if not exists (select 1 from private.agent_schedules where agent_key = 'account_manager' and task_kind = 'accounts.offers' and cadence = 'daily' and not requires_session) then
    raise exception 'The Account Manager''s daily offer schedule must exist' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> '["platform.agents.offers.v1"]'::jsonb) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || '["platform.agents.offers.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
