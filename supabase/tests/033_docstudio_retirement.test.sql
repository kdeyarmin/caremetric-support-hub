begin;
select plan(6);

select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'private' and c.relkind in ('r', 'p') and c.relname like 'docstudio\_%'),
  0::bigint, 'Retired DocStudio tables are absent');

select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname like 'docstudio\_%'),
  0::bigint, 'Retired DocStudio functions are absent');

select is((select count(*) from pg_trigger
  where tgrelid = 'private.publication_imports'::regclass and tgname = 'docstudio_publication_guard'),
  0::bigint, 'Shared publication imports no longer invoke the retired runtime');

select ok(not (hub.get_backend_contract()->'features' ? 'knowledge.docstudio.v1'),
  'Release metadata no longer advertises DocStudio');

select ok(hub.get_backend_contract()->'features' ? 'knowledge.publications.v1',
  'Shared publication imports remain supported');

select is((select count(*) from pg_trigger where not tgisinternal and
  (tgrelid = 'private.publication_revision_provenance'::regclass and tgname = 'publication_provenance_immutable'
   or tgrelid = 'hub.content_revisions'::regclass and tgname = 'publication_revision_immutable'
   or tgrelid = 'private.publication_import_assets'::regclass and tgname = 'publication_asset_immutable'
   or tgrelid = 'hub.content_publications'::regclass and tgname = 'publication_change_lock')),
  4::bigint, 'Shared publication immutability and locking guards remain installed');

select * from finish();
rollback;
