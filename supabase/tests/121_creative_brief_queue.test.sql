begin;
select plan(7);

select ok(has_function_privilege('hub_app_server', 'private.creative_brief_create(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'private.creative_brief_create(jsonb)', 'execute')
  and not has_function_privilege('service_role', 'private.creative_brief_create(jsonb)', 'execute'),
  'Creating briefs stays restricted to the Hub server');

-- The function's real queue operation, with only the session-user guard replaced inside this rolled-back test.
create or replace function private.require_hub_app_server() returns void
language plpgsql stable set search_path='' as $$ begin return; end; $$;
create temporary table creative_queue_result as select private.creative_brief_create(
  '{"product":"caremetric-intel","goal":"Show territory research","audience":"Marketing leaders at hospitals","platforms":["meta"],"formats":["static"],"source":"social.plan","requestKey":"test:atomic-creative-queue"}'::jsonb) as result;
select is((select result ->> 'created' from creative_queue_result), 'true', 'A new brief is created');
select is((select count(*) from private.agent_tasks t join creative_queue_result r on t.request_key = 'creative:brief:' || (r.result ->> 'id')
  where t.agent_key = 'creative_director' and t.kind = 'creative.request' and t.status = 'queued' and t.payload ->> 'briefId' = r.result ->> 'id'),
  1::bigint, 'Its drafting task already exists before the caller can enqueue it');
select is(private.creative_brief_create(
  '{"product":"caremetric-intel","goal":"Show territory research","audience":"Marketing leaders at hospitals","platforms":["meta"],"formats":["static"],"source":"social.plan","requestKey":"test:atomic-creative-queue"}'::jsonb) ->> 'created',
  'false', 'Retrying creates no second brief');
select is((select count(*) from private.agent_tasks t join creative_queue_result r on t.request_key = 'creative:brief:' || (r.result ->> 'id')),
  1::bigint, 'Retrying creates no second drafting task');

-- If the queue write fails, the brief must roll back too; an open brief without work used to survive this failure.
create function private.test_reject_creative_queue() returns trigger language plpgsql set search_path='' as $$
begin
  if new.kind = 'creative.request' then raise exception 'Test queue unavailable' using errcode = 'P0001'; end if;
  return new;
end; $$;
create trigger test_reject_creative_queue before insert on private.agent_tasks for each row execute function private.test_reject_creative_queue();
select throws_ok($$select private.creative_brief_create(
  '{"product":"caremetric-intel","goal":"Show territory research","audience":"Marketing leaders at hospitals","platforms":["meta"],"formats":["static"],"source":"social.plan","requestKey":"test:atomic-creative-rollback"}'::jsonb)$$,
  'P0001', 'Test queue unavailable', 'A queue failure is returned to the caller');
select is((select count(*) from private.creative_briefs where request_key = 'test:atomic-creative-rollback'), 0::bigint,
  'The failed queue write leaves no stranded brief');

select * from finish();
rollback;
