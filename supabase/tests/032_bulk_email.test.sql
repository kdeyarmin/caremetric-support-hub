begin;
select plan(11);

select ok(bool_and(to_regclass(tbl) is not null and (select relrowsecurity from pg_class where oid = to_regclass(tbl))),
  'Bulk email tables exist with row level security')
from unnest(array['private.email_campaigns', 'private.email_campaign_sources', 'private.email_audience_members',
  'private.email_recipients', 'private.email_suppressions']) as tbl;
select ok(not bool_or(has_table_privilege(role_name, tbl, 'select,insert,update,delete')
    or has_any_column_privilege(role_name, tbl, 'select,insert,update')),
  'No browser, service or server role touches bulk email tables directly')
from unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name,
  unnest(array['private.email_campaigns', 'private.email_campaign_sources', 'private.email_audience_members',
    'private.email_recipients', 'private.email_suppressions']) as tbl;

select ok(bool_and(has_function_privilege('hub_app_server', signature, 'execute')
    and not has_function_privilege('authenticated', signature, 'execute') and not has_function_privilege('anon', signature, 'execute')),
  'Only the Hub server delivers and unsubscribes')
from unnest(array['private.email_housekeeping()', 'private.claim_email_batch(integer)', 'private.finish_email_delivery(uuid,text,text)',
  'private.email_unsubscribe(text,boolean)']) as signature;
select throws_ok('select private.claim_email_batch(10)', '42501', 'Application server required.',
  'Claiming deliveries refuses every session user other than the Hub server');
select throws_ok($$select private.email_unsubscribe(repeat('a', 64), true)$$, '42501', 'Application server required.',
  'Unsubscribing refuses every session user other than the Hub server');

select ok(bool_and(has_function_privilege('authenticated', signature, 'execute') and not has_function_privilege('anon', signature, 'execute')),
  'Bulk email administration is a signed-in call only')
from unnest(array['hub.create_email_campaign(uuid[])', 'hub.next_email_audience_page(uuid)',
  'hub.add_email_audience_page(uuid,uuid,integer,integer,jsonb)', 'hub.get_email_campaign(uuid)', 'hub.list_email_campaigns()',
  'hub.save_email_campaign(uuid,text,text,jsonb,integer)', 'hub.queue_email_campaign(uuid,integer,integer)',
  'hub.cancel_email_campaign(uuid)', 'hub.authorize_email_test(uuid)']) as signature;

set local role authenticated;
select throws_ok('select hub.list_email_campaigns()', '28000', 'Current administrator session required.',
  'Listing bulk email requires the current administrator session');
select throws_ok('select hub.queue_email_campaign(gen_random_uuid(), 1, 1)', '28000', 'Current administrator session required.',
  'Sending bulk email requires the current administrator session');
reset role;

select is(private.email_hash('  Person@Agency.TEST '), encode(extensions.digest('person@agency.test', 'sha256'), 'hex'),
  'Addresses are hashed case- and space-insensitively');

-- A queued message keeps its address and token; a finished one keeps neither.
insert into private.email_campaigns (id, status, subject, body, recipient_count, queued_at)
  values ('00000000-0000-4000-8000-0000000000e1', 'sending', 'Subject', 'Body', 1, now());
select throws_ok($$insert into private.email_recipients (campaign_id, email_hash, email, unsubscribe_hash, applications, status)
  values ('00000000-0000-4000-8000-0000000000e1', repeat('a', 64), 'person@agency.test', repeat('b', 64), 'PennSync', 'sent')$$,
  '23514', null, 'A delivered message cannot keep its address');

select ok(hub.get_backend_contract()->'features' @> '["support.bulk-email.v1"]'::jsonb,
  'Bulk email is declared in release metadata');

select * from finish();
rollback;
