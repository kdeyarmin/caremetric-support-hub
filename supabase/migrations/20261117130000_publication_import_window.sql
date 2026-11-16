-- Large publication videos (docs/PUBLICATION_IMPORTS.md). A publication import stayed open for 30 minutes from staging, and at most
-- one hour, so a 512 MiB video sent in 8 MiB parts over a slow connection could outlast it. The Hub server now calls
-- private.keep_publication_import_open before each part and before it hands a checked file to Storage: the import then stays open
-- for at least 30 more minutes, up to 4 hours after it was staged. An abandoned import still closes 30 minutes after its last part,
-- and cleanup (private.issue_publication_cleanup) still waits 5 minutes past that, so no transfer the Hub starts after keeping the
-- import open (its deadlines are 10 minutes each way) can outlive it.

-- The window: replace the original unnamed check (expires_at at most one hour after created_at) with a named four-hour one.
do $$ declare existing record; begin
  for existing in select c.conname from pg_catalog.pg_constraint c
      where c.conrelid='private.publication_imports'::regclass and c.contype='c' and c.conname<>'publication_imports_window_check'
        and position('expires_at > created_at' in pg_catalog.pg_get_constraintdef(c.oid))>0 loop
    execute format('alter table private.publication_imports drop constraint %I',existing.conname);
  end loop;
end $$;
alter table private.publication_imports drop constraint if exists publication_imports_window_check;
alter table private.publication_imports add constraint publication_imports_window_check
  check(expires_at>created_at and expires_at<=created_at+interval '4 hours');

-- The current session's own uncommitted, unexpired import only (private.require_publication_import), from a verified Hub session,
-- like private.publication_object. Refuses once fewer than 30 minutes of the four hours remain, so whenever it answers the import
-- stays open for at least 30 more minutes. Returns the new closing time.
create or replace function private.keep_publication_import_open(p_id uuid) returns timestamptz
language plpgsql security definer set search_path='' as $$
declare intent private.publication_imports; closes timestamptz;
begin
  if not private.current_app_session_verified() then raise exception 'Current application session required.' using errcode='28000'; end if;
  perform 1 from private.publication_imports where id=p_id for update;
  intent:=private.require_publication_import(p_id);
  if intent.created_at+interval '4 hours'<now()+interval '30 minutes' then
    raise exception 'Import window closed.' using errcode='P4090';
  end if;
  update private.publication_imports set expires_at=greatest(expires_at,now()+interval '30 minutes') where id=p_id returning expires_at into closes;
  return closes;
end;
$$;
revoke all on function private.keep_publication_import_open(uuid) from public,anon,authenticated,service_role;
grant execute on function private.keep_publication_import_open(uuid) to hub_app_server;
