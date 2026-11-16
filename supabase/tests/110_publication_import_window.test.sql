begin;
select plan(9);

-- Large publication videos (20261117120000_publication_import_window.sql): an import may be kept open up to four hours after staging.
select is((select pg_get_constraintdef(oid) from pg_constraint where conrelid='private.publication_imports'::regclass and conname='publication_imports_window_check'),
  'CHECK (((expires_at > created_at) AND (expires_at <= (created_at + ''04:00:00''::interval))))', 'An import closes at most four hours after it was staged');
select is((select count(*) from pg_constraint where conrelid='private.publication_imports'::regclass and contype='c'
  and position('expires_at > created_at' in pg_get_constraintdef(oid))>0), 1::bigint, 'The one-hour window is replaced, not kept beside it');
select ok(has_function_privilege('hub_app_server','private.keep_publication_import_open(uuid)','execute'), 'The Hub server keeps its imports open');
select ok(not has_function_privilege('authenticated','private.keep_publication_import_open(uuid)','execute'), 'A browser session cannot extend an import itself');
select ok(not has_function_privilege('anon','private.keep_publication_import_open(uuid)','execute'), 'An anonymous caller cannot extend an import');
select ok(not has_function_privilege('service_role','private.keep_publication_import_open(uuid)','execute'), 'A service key does not become an editor');
select is((select prosecdef from pg_proc where oid='private.keep_publication_import_open(uuid)'::regprocedure), true, 'It rechecks the caller as the guarded publication functions do');
select throws_ok($$select private.keep_publication_import_open(gen_random_uuid())$$, '28000', 'Current application session required.',
  'Only a verified Hub session can keep an import open');
select ok(hub.get_backend_contract()->'features' @> '["knowledge.publications.direct-storage.v1"]'::jsonb, 'The direct transfer is declared once the window exists');

select * from finish();
rollback;
