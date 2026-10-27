-- Customer-invoked diagnostics run under the caller's live SMS session.
-- Only case/operation identifiers are retained; native secrets and profile
-- records are never persisted as support-tool results.
create table private.diagnostic_support_requests (
 actor_id uuid not null references auth.users(id),request_key uuid not null,
 connection_id uuid not null references private.self_service_connections(id) on delete cascade,
 operation_id uuid unique references private.self_service_operations(id) on delete set null,
 case_id uuid references hub.support_cases(id) on delete cascade,
 tool_state text check(tool_state in ('available','unavailable')),
 created_at timestamptz not null default now(),primary key(actor_id,request_key)
);
create index diagnostic_support_requests_connection on private.diagnostic_support_requests(connection_id);
create index diagnostic_support_requests_case on private.diagnostic_support_requests(case_id);
alter table private.diagnostic_support_requests enable row level security;
revoke all on private.diagnostic_support_requests from public,anon,authenticated,service_role,hub_app_server;

create function hub.get_diagnostic_support_receipt(p_connection uuid,p_request_key uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare saved private.diagnostic_support_requests;
begin
 perform private.require_hub_app_server();
 if not private.current_app_session_verified() or not private.current_user_is_usable() then raise exception 'Sign in to continue' using errcode='28000';end if;
 if not exists(select 1 from private.self_service_connections c where c.id=p_connection and c.user_id=auth.uid() and c.revoked_at is null and private.is_active_member(c.tenant_id,c.product_id))
 then raise exception 'Application connection unavailable' using errcode='42501';end if;
 select * into saved from private.diagnostic_support_requests where actor_id=auth.uid() and request_key=p_request_key;
 if not found then return null;end if;
 if saved.connection_id<>p_connection then raise exception 'Support request changed' using errcode='22023';end if;
 return (select jsonb_build_object('case_id',s.id,'case_number',s.case_number,'tool_state',saved.tool_state) from hub.support_cases s
  where s.id=saved.case_id and private.can_view_case(s.id,s.tenant_id,s.product_id,s.requester_id));
end;$$;

create function hub.create_diagnostic_support_case(p_connection uuid,p_request_key uuid,p_operation uuid,p_checks jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.self_service_connections; saved private.diagnostic_support_requests; created hub.support_case_queue; body text; product_name text;
begin
 perform private.require_hub_app_server();
 if not private.current_app_session_verified() or not private.current_user_is_usable() then raise exception 'Sign in to continue' using errcode='28000';end if;
 select * into c from private.self_service_connections where id=p_connection and user_id=auth.uid() and revoked_at is null;
 if not found or not private.is_active_member(c.tenant_id,c.product_id) then raise exception 'Application connection unavailable' using errcode='42501';end if;
 if p_request_key is null then raise exception 'A request key is required' using errcode='22023';end if;
 insert into private.diagnostic_support_requests(actor_id,request_key,connection_id) values(auth.uid(),p_request_key,p_connection)
 on conflict(actor_id,request_key) do nothing;
 select * into saved from private.diagnostic_support_requests where actor_id=auth.uid() and request_key=p_request_key for update;
 if saved.connection_id<>p_connection then raise exception 'Support request changed' using errcode='22023';end if;
 if saved.case_id is not null then return hub.get_diagnostic_support_receipt(p_connection,p_request_key);end if;
 if not exists(select 1 from private.self_service_operations o where o.id=p_operation and o.connection_id=c.id and o.user_id=auth.uid()
  and o.session_id=(auth.jwt()->>'sms_session_id')::uuid and o.operation->>'action'='diagnostics.read'
  and o.created_at>now()-interval '5 minutes'
  and o.result_state=case when p_checks is null then 'unavailable' else 'succeeded' end)
 then raise exception 'A current audited diagnostic is required' using errcode='42501';end if;
 if p_checks is not null then
  if jsonb_typeof(p_checks)<>'array' or jsonb_array_length(p_checks) not between 1 and 50 then raise exception 'Invalid diagnostic result' using errcode='22023';end if;
  if exists(select 1 from jsonb_array_elements(p_checks) x where jsonb_typeof(x)<>'object' or jsonb_typeof(x->'name') is distinct from 'string'
   or jsonb_typeof(x->'status') is distinct from 'string' or char_length(x->>'name') not between 1 and 180 or char_length(x->>'status') not between 1 and 64
   or (x-'name'-'status')<>'{}'::jsonb) then raise exception 'Invalid diagnostic result' using errcode='22023';end if;
  select 'Application connection checks:'||E'\n\n'||string_agg(replace(replace(x->>'name',E'\n',' '),E'\r',' ')||': '||replace(replace(x->>'status',E'\n',' '),E'\r',' '),E'\n')
   ||E'\n\nPlease help me troubleshoot this connection using the published guidance.' into body from jsonb_array_elements(p_checks) x;
 else body:='The application connection check is temporarily unavailable. Please help me troubleshoot this connection.';end if;
 select name into product_name from hub.products where id=c.product_id;
 select * into created from hub.create_support_case(c.tenant_id,c.product_id,left('Connection support: '||product_name,160),
  'technical_issue','normal',body,null,null,false,md5('diagnostic-case:'||p_request_key::text)::uuid);
 update private.diagnostic_support_requests set case_id=created.id,operation_id=p_operation,tool_state=case when p_checks is null then 'unavailable' else 'available' end
  where actor_id=auth.uid() and request_key=p_request_key;
 return hub.get_diagnostic_support_receipt(p_connection,p_request_key);
end;$$;
revoke all on function hub.get_diagnostic_support_receipt(uuid,uuid),hub.create_diagnostic_support_case(uuid,uuid,uuid,jsonb) from public,anon,service_role;
grant execute on function hub.get_diagnostic_support_receipt(uuid,uuid),hub.create_diagnostic_support_case(uuid,uuid,uuid,jsonb) to authenticated;

do $$ declare contract jsonb; begin
 if not (select relrowsecurity from pg_class where oid='private.diagnostic_support_requests'::regclass)
  or has_table_privilege('authenticated','private.diagnostic_support_requests','SELECT,INSERT,UPDATE,DELETE')
  or has_function_privilege('anon','hub.create_diagnostic_support_case(uuid,uuid,uuid,jsonb)','EXECUTE') then
  raise exception 'Diagnostic support must remain behind the customer session boundary' using errcode='55000';
 end if;
 select hub.get_backend_contract() into contract;
 if not (contract->'features' @> '["support.customer-diagnostics.v1"]'::jsonb) then
  contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.customer-diagnostics.v1"]'::jsonb);
 end if;
 execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
