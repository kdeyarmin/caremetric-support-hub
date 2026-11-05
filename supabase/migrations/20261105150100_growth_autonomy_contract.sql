-- Additive deployment gate for sales follow-ups and capped cold email. Declaring the feature changes no behavior by itself (both
-- autonomy steps start off, and sending still needs HUB_GROWTH_SEND_ENABLED and the signing key): it states that a contact found on a
-- business's own website is recorded as a role address and admits nothing else; that the contact finder, the qualification rules and
-- the evaluation schedule exist behind the Hub server boundary; that proposing and claiming a message re-check the owner's hand-over
-- (the agent active, on Act and trusted with the message's class, the agent row held while claiming), keep model-written and cold
-- email out of the product policy's automatic path, contact a business once and send at most ten cold emails a day; that a product
-- policy no longer overwrites an agent's list; and that the two autonomy steps exist. Every test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-autonomy.v1';
  signature text;
  role_name text;
  definition text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.customer-growth.v1","platform.agents.hardening.v1","platform.agents.autonomy.v1"]}'::jsonb) is not true then
    raise exception 'Apply customer growth, the AI team hardening and autonomy steps first' using errcode = '55000';
  end if;

  -- Contacts found online: role addresses only.
  if not exists (select 1 from pg_attribute where attrelid = 'private.growth_contacts'::regclass and attname = 'source_kind' and not attisdropped)
    or not coalesce((select position('''info''' in pg_get_constraintdef(oid)) > 0 and position('role_address' in pg_get_constraintdef(oid)) > 0
                     from pg_constraint where conrelid = 'private.growth_contacts'::regclass and conname = 'growth_contacts_role_address_check'), false) then
    raise exception 'A contact found online must be a checked role address' using errcode = '55000';
  end if;

  -- The qualification rules stay closed to every role.
  if not coalesce((select relrowsecurity from pg_class where oid = to_regclass('private.growth_qualification_rules')), false)
    or not exists (select 1 from private.growth_qualification_rules where active) then
    raise exception 'The qualification rules must exist with row level security and one active set' using errcode = '55000';
  end if;
  foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_table_privilege(role_name, 'private.growth_qualification_rules', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      or has_any_column_privilege(role_name, 'private.growth_qualification_rules', 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'The qualification rules must remain closed to every browser, service and server role' using errcode = '55000';
    end if;
  end loop;

  -- Server operations: security definer, pinned search path, Hub server only.
  foreach signature in array array['private.growth_contact_candidates(integer)', 'private.growth_record_contact(uuid,text,text)',
    'private.growth_auto_qualify(integer)', 'private.growth_propose(uuid,uuid)', 'private.growth_claim_message(uuid,uuid)',
    'private.growth_discover(text,jsonb)'] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
      or position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
      raise exception 'Growth server operation boundary invalid: %', signature using errcode = '55000';
    end if;
  end loop;
  foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if to_regprocedure('private.growth_message_class(text,text,text)') is null
      or has_function_privilege(role_name, 'private.growth_message_class(text,text,text)', 'EXECUTE') then
      raise exception 'The message class helper must exist and stay internal' using errcode = '55000';
    end if;
  end loop;

  -- A role address must be on the business's own domain and never one that unsubscribed.
  definition := pg_get_functiondef('private.growth_record_contact(uuid,text,text)'::regprocedure);
  if position('g.domain' in definition) = 0 or position('email_suppressions' in definition) = 0 or position('role_address' in definition) = 0 then
    raise exception 'The contact finder must keep to the business''s own domain and honor unsubscribes' using errcode = '55000';
  end if;

  -- Proposing: on its own only for a class the owner handed over.
  definition := pg_get_functiondef('private.growth_propose(uuid,uuid)'::regprocedure);
  if position('growth_message_class' in definition) = 0
    or position('v_agent.status=''active''' in definition) = 0 or position('v_agent.autonomy=''act''' in definition) = 0
    or position('m.model_generated or v_class=''growth.cold_email''' in definition) = 0 then
    raise exception 'Proposing a message must approve on its own only for a class the owner handed over' using errcode = '55000';
  end if;

  -- Claiming: trust re-checked with the agent row held; caps and once-per-business for cold email.
  definition := pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure);
  if position('where key=a.agent_key for share' in definition) = 0
    or position('a.decided_by is null and not (g.autonomy=''act''' in definition) = 0
    or position('not m.model_generated and not v_cold' in definition) = 0
    or position('v_cold_sent >= 10 then' in definition) = 0
    or position('business_contacted' in definition) = 0
    or position('evaluation_required' in definition) = 0
    or position('email_suppressions' in definition) = 0
    or position('set status=''cancelled'',withdrawn_at=now()' in definition) = 0 then
    raise exception 'Claiming a message must re-check the hand-over and keep the cold email caps' using errcode = '55000';
  end if;

  -- A withdrawn message frees its work's draft key, and only a withdrawn one, so withdrawn work is drafted again and nothing else is.
  definition := pg_get_functiondef('private.growth_draft(uuid,uuid,jsonb)'::regprocedure);
  if position('where withdrawn_at is null do nothing' in definition) = 0
    or not exists (select 1 from pg_indexes where schemaname = 'private' and tablename = 'growth_messages' and indexname = 'growth_messages_draft_key'
                   and indexdef like 'CREATE UNIQUE INDEX%' and indexdef like '%(work_id, opportunity_version, contact_version, policy_version) WHERE (withdrawn_at IS NULL)') then
    raise exception 'A withdrawn message must free its work''s draft key, and only a withdrawn one' using errcode = '55000';
  end if;

  -- A product policy adds or removes only its own value.
  definition := pg_get_functiondef('hub.growth_manage(text,jsonb)'::regprocedure);
  if position('''{auto_approve_kinds}'', ''["growth.message"]''' in definition) > 0 or position('v<>''growth.message''' in definition) = 0 then
    raise exception 'A product policy must not overwrite an agent''s list' using errcode = '55000';
  end if;

  if (select count(*) from private.agent_autonomy_steps where category in ('sales_followups', 'cold_email') and requires_feature = feature) <> 2 then
    raise exception 'The sales follow-up and cold email steps must exist' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.evaluate' and cadence = 'daily' and not requires_session) then
    raise exception 'The daily growth evaluation must be scheduled' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> jsonb_build_array(feature)) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || jsonb_build_array(feature));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
