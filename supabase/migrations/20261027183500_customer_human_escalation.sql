-- Customer-requested escalation stops automation immediately, even during a
-- provider outage. The usual two-attempt loop is otherwise unchanged.
create function hub.request_human_support(p_case_id uuid,p_request_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c hub.support_cases; state hub.case_ai_automation;
begin
 perform private.require_hub_app_server();
 if not private.current_app_session_verified() or not private.current_user_is_usable() then
  raise exception 'Sign in to continue' using errcode='28000';
 end if;
 if p_request_key is null then raise exception 'A request key is required' using errcode='22023';end if;
 select * into c from hub.support_cases where id=p_case_id;
 if not found or not private.can_view_case(c.id,c.tenant_id,c.product_id,c.requester_id)
  or private.has_staff_permission('case.write',c.product_id) then
  raise exception 'Support case unavailable' using errcode='42501';
 end if;
 if c.status in ('resolved','closed') then raise exception 'This case is already closed' using errcode='22023';end if;
 insert into hub.case_ai_automation(case_id,stage,halt_reason)
 values(p_case_id,'halted','human_requested') on conflict(case_id) do nothing;
 -- The worker locks automation before changing a case; use the same order.
 select * into state from hub.case_ai_automation where case_id=p_case_id for update;
 if state.halt_reason='human_requested' and state.escalated_at is not null then
  return jsonb_build_object('stage','halted','replayed',true);
 end if;
 update hub.support_cases set status='in_progress',resolved_at=null,
  priority=case when priority in ('low','normal') then 'high'::hub.case_priority else priority end
 where id=p_case_id and status not in ('resolved','closed');
 if not found then raise exception 'This case is already closed' using errcode='22023';end if;
 perform hub.reply_to_support_case(p_case_id,
  'Human support requested. Please have a support team member follow up on this case.',
  'customer',p_request_key);
 update hub.case_ai_automation set stage='halted',halt_reason='human_requested',
  escalated_at=coalesce(escalated_at,now()),responded_at=now(),response_source='portal',
  follow_up_due_at=null,retry_at=null where case_id=p_case_id;
 insert into private.audit_events(actor_id,action,entity_type,entity_id,tenant_id,product_id,case_id,changed_columns)
 values(auth.uid(),'case.human_requested','support_case',c.id,c.tenant_id,c.product_id,c.id,array['status','priority','ai_stage']);
 return jsonb_build_object('stage','halted','replayed',false);
end;$$;
revoke all on function hub.request_human_support(uuid,uuid) from public,anon,service_role;
grant execute on function hub.request_human_support(uuid,uuid) to authenticated;

do $$ declare contract jsonb; begin
 if to_regprocedure('hub.request_human_support(uuid,uuid)') is null
  or has_function_privilege('anon','hub.request_human_support(uuid,uuid)','EXECUTE') then
  raise exception 'Customer escalation must require an authenticated session' using errcode='55000';
 end if;
 select hub.get_backend_contract() into contract;
 if not (contract->'features' @> '["support.manual-escalation.v1"]'::jsonb) then
  contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.manual-escalation.v1"]'::jsonb);
 end if;
 execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
