-- Founder posts wait for their time slot like page posts (review of #182, 2026-11-13). The weekly social plan gives each post for the
-- founder's own LinkedIn profile a `scheduledFor` slot and asks private.social_schedule to hold it there, but the hold accepted only
-- `social.post`, so an approved founder post published as soon as the owner approved it. The hold now takes `social.founder_post` too,
-- with the same rules: a proposed or approved post is not started before its slot, one started early is handed back with the same hold,
-- and only within eight days; a founder post handed back returns to approved, since it is never approved automatically.
set local lock_timeout = '10s';

create or replace function private.social_schedule(p_action uuid, p_execution integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_at timestamptz;
begin
  perform private.require_hub_app_server();
  select * into v_action from private.agent_actions
   where id = p_action and (kind = 'social.post' or kind = 'social.founder_post') and agent_key = 'social_manager' for update;
  if not found then return false; end if;
  begin
    v_at := (v_action.input ->> 'scheduledFor')::timestamptz;
  exception when others then
    return false;
  end;
  if v_at is null or v_at > now() + interval '8 days' then return false; end if;
  if v_action.status in ('proposed', 'approved', 'auto_approved') then
    update private.agent_actions set not_before = greatest(v_at, now()), updated_at = now() where id = v_action.id;
    return true;
  end if;
  if v_action.status = 'executing' and v_action.executions = p_execution then
    -- A founder post is only ever approved by the owner, so it goes back to approved, never to automatically approved.
    update private.agent_actions set status = case when decided_by is null and kind <> 'social.founder_post' then 'auto_approved' else 'approved' end,
      executing_at = null, not_before = greatest(v_at, now() + interval '1 minute'), updated_at = now()
    where id = v_action.id;
    return true;
  end if;
  return false;
end;
$$;
revoke all on function private.social_schedule(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function private.social_schedule(uuid, integer) to hub_app_server;

do $$
declare
  v_def text := pg_get_functiondef('private.social_schedule(uuid,integer)'::regprocedure);
  r text;
begin
  if position('kind = ''social.post''' in v_def) = 0 or position('kind = ''social.founder_post''' in v_def) = 0
     or position('private.require_hub_app_server()' in v_def) = 0
     or not (select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p
             where p.oid = 'private.social_schedule(uuid,integer)'::regprocedure) then
    raise exception 'Founder posts must wait for their time slot as page posts do' using errcode = '55000';
  end if;
  if not has_function_privilege('hub_app_server', 'private.social_schedule(uuid,integer)', 'execute') then
    raise exception 'The Hub server must be able to hold a post' using errcode = '55000';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'private.social_schedule(uuid,integer)', 'execute') then
      raise exception 'Holding a post exposed to %', r using errcode = '55000';
    end if;
  end loop;
end $$;
