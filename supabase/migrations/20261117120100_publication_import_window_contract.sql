-- Declares knowledge.publications.direct-storage.v1 once an import can be kept open (20261117120000_publication_import_window.sql).
-- While it is declared, the Hub server keeps an import open as its parts arrive and hands a checked file to Storage itself: the
-- publication-media function signs a one-time upload address for that exact object (never overwriting one), and after the upload a
-- one-time read address, which the Hub uses to read the stored object back and hash it before private.verify_publication_asset
-- records it. Neither address leaves the server. Deploy the publication-media function with its sign and check operations before
-- applying this; until it is declared, the Hub streams files through that function as before.
do $$ declare contract jsonb:=hub.get_backend_contract(); begin
  if (contract @> '{"api_version":4,"features":["knowledge.publications.v1"]}'::jsonb) is not true
    or to_regprocedure('private.keep_publication_import_open(uuid)') is null
    or not exists(select 1 from pg_catalog.pg_constraint c where c.conrelid='private.publication_imports'::regclass
      and c.conname='publication_imports_window_check' and c.contype='c' and c.convalidated) then
    raise exception 'Apply 20261117120000_publication_import_window.sql first' using errcode='55000';
  end if;
  if not (contract->'features' @> '["knowledge.publications.direct-storage.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["knowledge.publications.direct-storage.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
