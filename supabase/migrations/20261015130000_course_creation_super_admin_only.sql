-- Owner rule (2026-10-15): only the super admin can create courses.
-- The shared learning editor gate now requires the portfolio-wide
-- platform.admin staff permission -- the same source of truth that
-- hub.authorize_platform_admin() and hub.authorize_app_admin() already
-- check -- instead of a portfolio-wide content.write grant. The governed
-- app-command flows (course creation intents, authoring intents, course
-- distribution) already required platform.admin through
-- hub.authorize_app_command(); this change makes the direct editor
-- surface match: draft creation and editing, publication, media
-- registration, source staging, and draft imports. Learner consumption
-- is deliberately untouched: the owner authored the entire existing
-- catalog, and every existing course remains visible to end users.
create or replace function private.require_learning_editor() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_learning_user();
  -- Only the platform administrator creates or edits shared courses. A
  -- content permission, even scoped portfolio-wide, no longer suffices.
  if not private.has_staff_permission('platform.admin', null) then
    raise exception 'Shared-course editor access required.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

create or replace function hub.get_learning_editor_access() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_staff_permission('platform.admin', null);
$$;
