-- Advertise only after the complete growth boundary exists. Old servers ignore this additive feature.
do $$ declare c jsonb:=hub.get_backend_contract(); n text; r text; f oid; begin
 if not(c->'features' @> '["platform.agents.hardening.v1","platform.agents.accounts.v1"]') then raise exception 'Apply agent prerequisites first' using errcode='55000'; end if;
 foreach n in array array['growth_organizations','growth_contacts','growth_opportunities','growth_evidence','customer_activity_events','customer_success_plans','growth_policies','growth_messages','growth_delivery_events','agent_evaluations','agent_budget_reservations'] loop
  if not coalesce((select relrowsecurity from pg_class where oid=to_regclass('private.'||n)),false) then raise exception 'Growth RLS is missing: %',n using errcode='55000'; end if;
  foreach r in array array['anon','authenticated','service_role','hub_app_server'] loop
   if has_table_privilege(r,'private.'||n,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') or has_any_column_privilege(r,'private.'||n,'SELECT,INSERT,UPDATE,REFERENCES') then raise exception 'Growth tables must remain private: %',n using errcode='55000'; end if;
  end loop;
 end loop;
 foreach n in array array['growth_content_context(text)','growth_propose_content(uuid,text,jsonb)','growth_snapshot(integer)','growth_record_event(text,jsonb)','growth_plan(uuid,jsonb)','growth_draft(uuid,uuid,jsonb)','growth_propose(uuid,uuid)','growth_claim_message(uuid,uuid)','growth_finish_message(uuid,text,text)','growth_delivery_event(text,uuid,text,timestamptz)','growth_unsubscribe(text)','growth_discover(text,jsonb)','growth_inquiry(uuid)','growth_evaluate(text,text,boolean,jsonb)','growth_assess(uuid,jsonb)','growth_budget_reserve(uuid,numeric)','growth_budget_release(uuid)','growth_brief_counts()','growth_maintenance()','growth_notification_status(text)','growth_defer_action(uuid,integer)','agent_actions_ready(integer,text[],text[])','agent_action_execution(uuid)','agent_accounts_page(integer,integer)'] loop
  f:=to_regprocedure('private.'||n);
  if f is null or not exists(select 1 from pg_proc where oid=f and prosecdef and proconfig @> array['search_path=""'] and prosrc like '%require_hub_app_server%') or not has_function_privilege('hub_app_server',f,'EXECUTE') then raise exception 'Growth server boundary invalid: %',n using errcode='55000'; end if;
  foreach r in array array['anon','authenticated','service_role'] loop
   if has_function_privilege(r,f,'EXECUTE') then raise exception 'Growth operation exposed: %',n using errcode='55000'; end if;
  end loop;
 end loop;
 if not exists(select 1 from pg_attribute where attrelid='private.agent_actions'::regclass and attname='not_before' and atttypid='timestamptz'::regtype and not attisdropped)
 or exists(select 1 from pg_proc where oid in ('private.agent_actions_ready(integer,text[],text[])'::regprocedure,'private.agent_action_execution(uuid)'::regprocedure) and prosrc not like '%not_before%') then
  raise exception 'Growth deferral clock is missing' using errcode='55000';
 end if;
 foreach n in array array['growth_workspace(integer)','growth_manage(text,jsonb)','growth_detail(uuid)','growth_research_target(uuid)'] loop
  f:=to_regprocedure('hub.'||n);
  if f is null or not exists(select 1 from pg_proc where oid=f and prosecdef and proconfig @> array['search_path=""'] and (prosrc like '%authorize_app_admin%' or prosrc like '%authorize_app_command%')) or not has_function_privilege('authenticated',f,'EXECUTE') then raise exception 'Growth owner authorization invalid: %',n using errcode='55000'; end if;
  foreach r in array array['anon','service_role'] loop
   if has_function_privilege(r,f,'EXECUTE') then raise exception 'Growth owner operation exposed: %',n using errcode='55000'; end if;
  end loop;
 end loop;
 if not(c->'features' @> '["platform.agents.customer-growth.v1"]') then c:=jsonb_set(c,'{features}',(c->'features')||'["platform.agents.customer-growth.v1"]'); end if;
 execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(c::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
