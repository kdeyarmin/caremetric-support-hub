-- Mutation delegation retains the native CareBase eight-hour privileged-session
-- window. Refreshing a token does not extend the original session creation time.
create function hub.authorize_platform_command()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  actor jsonb;
  session_id uuid;
  started_at timestamptz;
  not_after timestamptz;
  issued_at text := (select auth.jwt()->>'iat');
begin
  actor := hub.authorize_platform_admin();
  session_id := (select auth.jwt()->>'session_id')::uuid;
  select s.created_at,s.not_after into started_at,not_after
    from auth.sessions s where s.id=session_id and s.user_id=(actor->>'user_id')::uuid;
  if started_at is null or started_at < now()-interval '480 minutes'
    or started_at > now()+interval '5 minutes'
    or issued_at is null or issued_at !~ '^[0-9]{1,12}$' then
    raise exception 'Sign in again before changing application access.' using errcode='28000';
  end if;
  if issued_at::numeric > extract(epoch from now()+interval '5 minutes') then
    raise exception 'Sign in again before changing application access.' using errcode='28000';
  end if;
  return actor || jsonb_build_object('session_id',session_id,'session_started_at',started_at,
    'assurance_expires_at',least(started_at+interval '480 minutes',not_after));
end;
$$;
revoke all on function hub.authorize_platform_command() from public,anon,authenticated;
grant execute on function hub.authorize_platform_command() to authenticated;
