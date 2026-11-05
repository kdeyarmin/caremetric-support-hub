begin;
select plan(16);

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.growth-autonomy.v1"]'::jsonb, 'Sales follow-ups and cold email are declared in release metadata');

-- The server boundary.
select ok(bool_and(p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false)), 'Every growth autonomy operation is a security definer with a pinned empty search path')
from pg_proc p where p.oid in ('private.growth_contact_candidates(integer)'::regprocedure, 'private.growth_record_contact(uuid,text,text)'::regprocedure,
  'private.growth_auto_qualify(integer)'::regprocedure, 'private.growth_propose(uuid,uuid)'::regprocedure, 'private.growth_claim_message(uuid,uuid)'::regprocedure);
select ok(bool_and(has_function_privilege('hub_app_server', f, 'execute')
    and not has_function_privilege('anon', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('service_role', f, 'execute')),
  'Only the Hub server finds contacts, qualifies, proposes and claims')
from unnest(array['private.growth_contact_candidates(integer)', 'private.growth_record_contact(uuid,text,text)', 'private.growth_auto_qualify(integer)',
  'private.growth_propose(uuid,uuid)', 'private.growth_claim_message(uuid,uuid)']) f;
select ok(not bool_or(has_function_privilege(role_name, 'private.growth_message_class(text,text,text)', 'execute')), 'The message class helper is internal')
from unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) role_name;

-- Role addresses only.
insert into private.growth_organizations (id, name, domain, discovered_at) values ('0063aaaa-0000-4000-8000-000000000001', 'Synthetic home', 'pgtap-063.example.org', now());
insert into private.growth_contacts (organization_id, email, source_kind, eligibility, verified_at, source_url)
values ('0063aaaa-0000-4000-8000-000000000001', 'info@pgtap-063.example.org', 'role_address', 'permitted', now(), 'https://pgtap-063.example.org/contact');
select is((select source_kind from private.growth_contacts where email = 'info@pgtap-063.example.org'), 'role_address', 'A role address can be recorded as found online');
select throws_ok($$insert into private.growth_contacts (organization_id, email, source_kind) values ('0063aaaa-0000-4000-8000-000000000001', 'pat.example@pgtap-063.example.org', 'role_address')$$,
  '23514', null, 'A personal address is never recorded as found online');
select lives_ok($$insert into private.growth_contacts (organization_id, email) values ('0063aaaa-0000-4000-8000-000000000001', 'pat.example@pgtap-063.example.org')$$,
  'A contact the owner adds keeps any address, as before');
select is((select source_kind from private.growth_contacts where email = 'pat.example@pgtap-063.example.org'), 'owner', 'and is recorded as the owner''s');

-- Classes.
select is(private.growth_message_class('marketing_manager', 'marketing', 'role_address'), 'growth.cold_email', 'Outreach to a found role address is cold email');
select is(array[private.growth_message_class('marketing_manager', 'marketing', 'owner'), private.growth_message_class('marketing_manager', 'success', 'role_address')],
  array['growth.sales_followup', 'growth.sales_followup'], 'Everything else the Marketing Manager sends is a sales follow-up');
select is(private.growth_message_class('account_manager', 'success', 'owner'), null, 'Other agents'' messages have no class and keep the product policy''s rules');

-- Qualification rules: closed, one active versioned set.
select ok((select relrowsecurity from pg_class where oid = 'private.growth_qualification_rules'::regclass)
  and not bool_or(has_table_privilege(role_name, 'private.growth_qualification_rules', 'select')), 'The qualification rules are closed to every role')
from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name;
select is((select array_agg(version) from private.growth_qualification_rules where active), array['qualify.1'], 'One active rule set, versioned');

-- The steps and the schedule.
select is((select jsonb_object_agg(category, changes) from private.agent_autonomy_steps where category in ('sales_followups', 'cold_email')),
  '{"cold_email": [{"agent": "marketing_manager", "values": ["growth.cold_email"], "config_key": "auto_approve_kinds"}],
    "sales_followups": [{"agent": "marketing_manager", "values": ["growth.sales_followup"], "config_key": "auto_approve_kinds"}]}'::jsonb,
  'Each step hands over exactly its own class');
select ok(exists (select 1 from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.evaluate' and cadence = 'daily' and not requires_session),
  'The daily evaluation is scheduled');

-- Handing cold email over and back changes only its own value, and keeps a policy's growth.message.
update private.agents set autonomy = 'propose', config = jsonb_set(config, '{auto_approve_kinds}', '["growth.message"]') where key = 'marketing_manager';
select private.agent_autonomy_apply('cold_email', 'automatic', null, 'pgtap');
select private.agent_autonomy_apply('cold_email', 'hold', null, 'pgtap');
select is((select array[autonomy, config ->> 'auto_approve_kinds'] from private.agents where key = 'marketing_manager'), array['act', '["growth.message"]'],
  'Automatic, then Keep approving, leaves the policy''s growth.message in place');

select * from finish();
rollback;
