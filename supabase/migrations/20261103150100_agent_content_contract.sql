-- Additive deployment gate for the Content Marketer. Declaring the feature changes no behavior: it states that the article action
-- kind exists with its shape check and its once-per-address and once-per-topic indexes, that the two new operations are security
-- definers with a pinned empty search path executable by the Hub server role alone (and that publishing refuses an article nobody
-- approved), that the AI assistant profile the articles are authored by exists, and that the agent and its two schedules exist.
-- It needs the AI team control plane and its hardening (the fenced executions the publishing operation checks), the governed
-- content publications the articles join, and the communications inbox whose counts choose a topic. Every test fails closed, as
-- in the hardening gate: a function whose search_path setting was reset (which leaves it null) is refused. The gate refuses to
-- declare the feature if any of it has drifted.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  signature text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.v1","platform.agents.hardening.v1","knowledge.publications.v1","support.communications.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI team control plane and its hardening, governed publications and the communications inbox first' using errcode = '55000';
  end if;

  if not exists (select 1 from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_content_publish_check'
      and position('content.publish' in pg_get_constraintdef(oid)) > 0)
    or not coalesce((select position('''content.publish''' in pg_get_constraintdef(oid)) > 0 from pg_constraint
                     where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_kind_check'), false)
    or not coalesce((select position('''content_item''' in pg_get_constraintdef(oid)) > 0 from pg_constraint
                     where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_target_kind_check'), false)
    or not exists (select 1 from pg_index i where i.indexrelid = to_regclass('private.agent_actions_content_publish_slug') and i.indisunique)
    or not exists (select 1 from pg_index i where i.indexrelid = to_regclass('private.agent_actions_content_publish_topic') and i.indisunique) then
    raise exception 'Articles must be a checked action kind, proposed once per address and per topic' using errcode = '55000';
  end if;

  foreach signature in array array[
    'private.agent_content_state(text[])',
    'private.agent_content_publish(uuid,integer)'
  ] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
      or position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
      raise exception 'Content Marketer operations must be security definer with a pinned search path, executable by the Hub server only' using errcode = '55000';
    end if;
  end loop;
  if position('decided_by is null' in pg_get_functiondef(to_regprocedure('private.agent_content_publish(uuid,integer)'))) = 0
    or position('a1a00000-a1a0-4000-8000-000000000001' in pg_get_functiondef(to_regprocedure('private.agent_content_publish(uuid,integer)'))) = 0 then
    raise exception 'Articles must be published by the AI assistant only with the owner''s approval' using errcode = '55000';
  end if;
  if not exists (select 1 from auth.users where id = 'a1a00000-a1a0-4000-8000-000000000001')
    or not exists (select 1 from hub.profiles where id = 'a1a00000-a1a0-4000-8000-000000000001') then
    raise exception 'The CareMetric AI Assistant profile must exist' using errcode = '55000';
  end if;

  if not exists (select 1 from private.agents where key = 'content_marketer'
      and jsonb_typeof(config -> 'auto_approve_kinds') = 'array' and config ? 'effort') then
    raise exception 'The Content Marketer must exist with its settings' using errcode = '55000';
  end if;
  if (select count(*) from private.agent_schedules
      where agent_key = 'content_marketer' and task_kind in ('content.weekly', 'content.outreach') and cadence = 'daily' and not requires_session) <> 2 then
    raise exception 'The Content Marketer weekly and outreach schedules must exist' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> '["platform.agents.content.v1"]'::jsonb) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || '["platform.agents.content.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
