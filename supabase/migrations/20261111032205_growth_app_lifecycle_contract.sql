do $$ declare contract jsonb:=hub.get_backend_contract(); signature text; begin
 foreach signature in array array['private.growth_app_event(text,jsonb)','private.growth_drain_billing()'] loop
  if to_regprocedure(signature) is null or not has_function_privilege('hub_app_server',signature,'execute')
   or exists(select 1 from unnest(array['anon','authenticated','service_role']) r where has_function_privilege(r,signature,'execute')) then
   raise exception 'Growth activity server boundary missing: %',signature;
  end if;
 end loop;
 if not (contract->'features' @> '["platform.agents.app-growth.v1"]'::jsonb) then
  contract:=jsonb_set(contract,'{features}',(contract->'features')||'["platform.agents.app-growth.v1"]'::jsonb);
 end if;
 execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
