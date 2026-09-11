begin;
select plan(4);

select ok(not p.prosecdef, 'Public release metadata uses invoker privileges')
from pg_proc p where p.oid = 'hub.get_backend_contract()'::regprocedure;

set local role anon;
select is(hub.get_backend_contract(), '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1"]}'::jsonb, 'Anonymous callers see only the reviewed release features');
reset role;

set local role authenticated;
select is(hub.get_backend_contract(), '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1"]}'::jsonb, 'Authenticated callers see the same release metadata');
select throws_ok('select hub.get_support_actor_context()', '28000', 'Authentication required', 'Release metadata never grants actor access');
reset role;

select * from finish();
rollback;
