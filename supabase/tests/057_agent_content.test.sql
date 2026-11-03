begin;
select plan(44);

create temporary table content_operations(signature text primary key) on commit drop;
insert into content_operations values
  ('private.agent_content_state(text[])'),
  ('private.agent_content_publish(uuid,integer)');

-- ---------------------------------------------------------------------------------------
-- The boundary: two server-only operations, and nobody else may call them.
-- ---------------------------------------------------------------------------------------
select ok(bool_and(p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false)) and count(*) = 2,
  'Both Content Marketer operations are security definers with a pinned empty search path')
from content_operations operation join pg_proc p on p.oid = to_regprocedure(operation.signature);
select ok(bool_and(has_function_privilege('hub_app_server', operation.signature, 'execute')),
  'The Hub server role executes both operations')
from content_operations operation;
select ok(not bool_or(has_function_privilege(role_name, operation.signature, 'execute')),
  'No browser, service or public role executes either operation')
from content_operations operation cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) as role_name;

select throws_ok('select private.agent_content_state()', '42501', 'Application server required.',
  'Reading the content state refuses every session user other than the Hub server');
select throws_ok($$select private.agent_content_state(array['a-slug'])$$, '42501', 'Application server required.',
  'Even a narrowed read refuses every session user other than the Hub server');
select throws_ok('select private.agent_content_publish(gen_random_uuid(), 1)', '42501', 'Application server required.',
  'Publishing refuses every session user other than the Hub server');

set local role authenticated;
select throws_ok('select private.agent_content_state()', '42501', 'permission denied for function agent_content_state',
  'Signed-in users cannot read the content state');
select throws_ok('select private.agent_content_publish(gen_random_uuid(), 1)', '42501', 'permission denied for function agent_content_publish',
  'Signed-in users cannot publish');
reset role;
set local role anon;
select throws_ok('select private.agent_content_state()', '42501', null, 'Anonymous callers cannot read the content state');
select throws_ok('select private.agent_content_publish(gen_random_uuid(), null)', '42501', null, 'Anonymous callers cannot publish');
reset role;

select ok(position('decided_by is null' in pg_get_functiondef('private.agent_content_publish(uuid,integer)'::regprocedure)) > 0,
  'Publishing checks that the owner decided the action');
select ok(position('a1a00000-a1a0-4000-8000-000000000001' in pg_get_functiondef('private.agent_content_publish(uuid,integer)'::regprocedure)) > 0,
  'Publishing authors the article as the AI assistant');
select ok(exists (select 1 from hub.profiles where id = 'a1a00000-a1a0-4000-8000-000000000001' and display_name = 'CareMetric AI Assistant'),
  'The AI assistant profile the articles are authored by exists');

-- ---------------------------------------------------------------------------------------
-- The release metadata and the agent.
-- ---------------------------------------------------------------------------------------
select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.content.v1"]'::jsonb,
  'The Content Marketer is declared in release metadata');
select is((select array[status, autonomy, model_tier, display_name] from private.agents where key = 'content_marketer'),
  array['paused', 'propose', 'draft', 'Content Marketer'], 'The Content Marketer starts paused, in Propose, on the draft tier');
select is((select daily_budget_cents from private.agents where key = 'content_marketer'), 150, 'It has a daily budget of $1.50');
select is((select config from private.agents where key = 'content_marketer'), '{"effort": "medium", "auto_approve_kinds": []}'::jsonb,
  'It approves nothing on its own and drafts at medium effort');
select ok((select char_length(role_summary) between 1 and 400 and role_summary like '%for you to approve before it is published%' from private.agents where key = 'content_marketer'),
  'Its role says that nothing is published without the owner');
select ok((select count(*) = 1 from private.agent_schedules where agent_key = 'content_marketer' and task_kind = 'content.weekly' and cadence = 'daily'
    and at_local = '07:45' and timezone = 'America/New_York' and not requires_session and enabled and next_run_at > now()),
  'The weekly article runs every morning at 07:45 Eastern (the handler writes on Tuesdays), with no owner session needed');
select ok((select count(*) = 1 from private.agent_schedules where agent_key = 'content_marketer' and task_kind = 'content.outreach' and cadence = 'daily'
    and at_local = '08:05' and timezone = 'America/New_York' and not requires_session and enabled and next_run_at > now()),
  'The outreach drafts run every morning at 08:05 Eastern (the handler writes once a month)');

-- ---------------------------------------------------------------------------------------
-- The action: the kind is added beside every kind the table allowed before, with a checked shape.
-- ---------------------------------------------------------------------------------------
select ok((select position('''content.publish''' in pg_get_constraintdef(oid)) > 0
    and position('''communication.reply''' in pg_get_constraintdef(oid)) > 0 and position('''incident.resolve''' in pg_get_constraintdef(oid)) > 0
    and position('''import.run''' in pg_get_constraintdef(oid)) > 0
  from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_kind_check'),
  'Articles are an action kind, and every kind allowed before is kept');
select ok((select position('''content_item''' in pg_get_constraintdef(oid)) > 0 and position('''communication''' in pg_get_constraintdef(oid)) > 0
    and position('''probe_target''' in pg_get_constraintdef(oid)) > 0
  from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_target_kind_check'),
  'An article is aimed at a content item, and every target kind allowed before is kept');

create temporary table content_input(input jsonb) on commit drop;
insert into content_input values (jsonb_build_object(
  'slug', 'pgtap-fire-drill-requirements', 'product', 'carebase', 'topic', 'pa-fire-drill-requirements', 'kind', 'regulation',
  'title', 'Fire drill requirements for personal care homes',
  'description', 'How often Pennsylvania personal care homes and ALFs hold fire drills and what the record shows.',
  'body', '**In short:** hold a drill every month.' || chr(10) || chr(10) || repeat('Drills and records. ', 40) || chr(10) || chr(10)
    || '*This article is general information about Pennsylvania regulations, not legal advice.*',
  'promptVersion', 'content.1'));
create function pg_temp.article(p_changes jsonb default '{}'::jsonb, p_remove text default null) returns jsonb
language sql as $$ select (input || p_changes) - coalesce(p_remove, '') from content_input $$;

select lives_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    values ('content_marketer', 'content.publish', 'content_item', 'pgtap-fire-drill-requirements', 'Publish: the whole article', pg_temp.article(), 'rejected')$$,
  'An article with exactly its facts is a valid action');
select lives_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input)
    values ('content_marketer', 'content.publish', 'content_item', 'pgtap-fire-drill-requirements', 'Publish: the whole article', pg_temp.article())$$,
  'A rejected article does not hold its address, so it may be proposed again');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input)
    values ('content_marketer', 'content.publish', 'content_item', 'pgtap-fire-drill-requirements', 'Again', pg_temp.article('{"topic": "another-topic"}'))$$,
  '23505', null, 'An address holds one live article, whichever task proposes it');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input)
    values ('content_marketer', 'content.publish', 'content_item', 'pgtap-another-address', 'Again', pg_temp.article('{"slug": "pgtap-another-address"}'))$$,
  '23505', null, 'A topic holds one live article, whatever address it is given');
select lives_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    values ('content_marketer', 'content.publish', 'content_item', 'pgtap-another-address', 'Expired', pg_temp.article('{"slug": "pgtap-another-address"}'), 'expired')$$,
  'An expired proposal holds neither');

select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    values ('content_marketer', 'content.publish', 'content_item', 'pgtap-shape', 'S', pg_temp.article('{"slug": "pgtap-shape", "to": "someone@example.test"}'), 'rejected')$$,
  '23514', null, 'An article cannot carry anything outside its facts');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    values ('content_marketer', 'content.publish', 'communication', 'pgtap-shape', 'S', pg_temp.article('{"slug": "pgtap-shape"}'), 'rejected')$$,
  '23514', null, 'An article is aimed at a content item');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    values ('content_marketer', 'content.publish', 'content_item', 'pgtap-other', 'S', pg_temp.article('{"slug": "pgtap-shape"}'), 'rejected')$$,
  '23514', null, 'Its target is the address its facts name');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    values ('content_marketer', 'content.publish', 'content_item', 'Not A Slug', 'S', pg_temp.article('{"slug": "Not A Slug"}'), 'rejected')$$,
  '23514', null, 'Its address is lowercase words joined by hyphens');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    values ('content_marketer', 'content.publish', 'content_item', 'pgtap-shape', 'S', pg_temp.article('{"slug": "pgtap-shape", "product": "pennsync"}'), 'rejected')$$,
  '23514', null, 'Only CareBase, Intel and Advisors articles are published');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    values ('content_marketer', 'content.publish', 'content_item', 'pgtap-shape', 'S', pg_temp.article('{"slug": "pgtap-shape", "kind": "opinion"}'), 'rejected')$$,
  '23514', null, 'An article is a regulation or a marketing article');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    values ('content_marketer', 'content.publish', 'content_item', 'pgtap-shape', 'S', pg_temp.article('{"slug": "pgtap-shape"}', 'description'), 'rejected')$$,
  '23514', null, 'A missing fact fails the check instead of passing as unknown');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    values ('content_marketer', 'content.publish', 'content_item', 'pgtap-shape', 'S', pg_temp.article('{"slug": "pgtap-shape", "title": 42}'), 'rejected')$$,
  '23514', null, 'Each fact is text');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    values ('content_marketer', 'content.publish', 'content_item', 'pgtap-shape', 'S', pg_temp.article('{"slug": "pgtap-shape", "title": "Short"}'), 'rejected')$$,
  '23514', null, 'A title has a sensible length');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    values ('content_marketer', 'content.publish', 'content_item', 'pgtap-shape', 'S', pg_temp.article('{"slug": "pgtap-shape", "title": "Fire drills <script>alert(1)</script>"}'), 'rejected')$$,
  '23514', null, 'A title carries no markup');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    select 'content_marketer', 'content.publish', 'content_item', 'pgtap-shape', 'S',
      pg_temp.article(jsonb_build_object('slug', 'pgtap-shape', 'body', (input ->> 'body') || ' <img src=x onerror=alert(1)>')), 'rejected' from content_input$$,
  '23514', null, 'The body carries no HTML');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    select 'content_marketer', 'content.publish', 'content_item', 'pgtap-shape', 'S',
      pg_temp.article(jsonb_build_object('slug', 'pgtap-shape', 'body', replace(input ->> 'body', 'not legal advice', 'general information'))), 'rejected' from content_input$$,
  '23514', null, 'An article about a regulation carries the "not legal advice" line');
select lives_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    select 'content_marketer', 'content.publish', 'content_item', 'pgtap-marketing', 'S',
      pg_temp.article(jsonb_build_object('slug', 'pgtap-marketing', 'topic', 'pgtap-marketing', 'product', 'caremetric-intel', 'kind', 'marketing',
        'body', replace(input ->> 'body', 'not legal advice', 'general information'))), 'rejected' from content_input$$,
  'A marketing article needs no legal line');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    values ('content_marketer', 'content.publish', 'content_item', 'pgtap-shape', 'S', pg_temp.article('{"slug": "pgtap-shape", "body": "Too short to be an article."}'), 'rejected')$$,
  '23514', null, 'The body has a sensible length');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    values ('content_marketer', 'content.publish', 'content_item', 'pgtap-shape', 'S', pg_temp.article('{"slug": "pgtap-shape", "promptVersion": "Not A Version!"}'), 'rejected')$$,
  '23514', null, 'The prompt version, when given, is a version');
select lives_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input)
    values ('platform_engineer', 'incident.open', 'probe_target', 'carebase', 'CareBase is down', '{}'::jsonb)$$,
  'Every kind the table allowed before is still allowed, with no shape of its own to meet');

select ok((select i.indisunique from pg_index i where i.indexrelid = 'private.agent_actions_content_publish_slug'::regclass)
    and (select i.indisunique from pg_index i where i.indexrelid = 'private.agent_actions_content_publish_topic'::regclass),
  'One live article per address and per topic is a unique index');

select * from finish();
rollback;
