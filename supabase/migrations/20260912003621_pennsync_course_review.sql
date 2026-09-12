-- Exact preserved source is returned only to the application server after a
-- current SMS administrator check. Browser review uses a separate projection.
create function private.pennsync_learning_review_source(p_revision text) returns text
language plpgsql security definer set search_path='' as $$
declare actor uuid; authority jsonb; snapshot private.pennsync_learning_snapshots%rowtype;
begin
 authority:=hub.authorize_app_command(); actor:=private.require_learning_editor();
 if (authority->>'assurance_expires_at')::timestamptz<=clock_timestamp() or not exists(
   select 1 from private.sms_sessions s join private.sms_identities i on i.user_id=s.user_id and i.identity_version=s.identity_version
   where s.id=(authority->>'session_id')::uuid and s.user_id=actor and s.revoked_at is null and i.revoked_at is null
     and s.expires_at>clock_timestamp() and s.created_at+interval '8 hours'>clock_timestamp()) then
   raise exception 'Current administrator session required' using errcode='28000';end if;
 if p_revision is null or p_revision !~ '^[a-f0-9]{64}$' then raise exception 'Invalid source revision' using errcode='22023';end if;
 select * into snapshot from private.pennsync_learning_snapshots order by sequence desc limit 1;
 if not found or snapshot.source_revision<>p_revision then raise exception 'Preserved source head changed' using errcode='40001';end if;
 return snapshot.source_payload;
end $$;
revoke all on function private.pennsync_learning_review_source(text) from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.pennsync_learning_review_source(text) to hub_app_server;
