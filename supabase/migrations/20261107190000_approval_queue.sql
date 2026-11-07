-- The AI team screen loaded only the 50 oldest open proposals. The count included the rest, so a newer
-- proposal could sit in "Waiting for you" with no Approve or Reject until older ones were cleared.
-- Load enough of the queue for the screen to page through. Anything past this cap is still counted.

create or replace function hub.get_agent_team() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform hub.authorize_app_admin();
  return jsonb_build_object(
    'loadedAt', now(),
    'dayStart', private.agent_day_start(),
    'agents', (
      select coalesce(jsonb_agg(private.agent_summary_json(a.key) order by a.display_name), '[]'::jsonb)
      from private.agents a),
    'approvals', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', x.id, 'agentKey', x.agent_key, 'agentName', x.agent_name, 'taskId', x.task_id,
        'kind', x.kind, 'targetKind', x.target_kind, 'targetId', x.target_id, 'preview', x.preview,
        'createdAt', x.created_at, 'expiresAt', x.expires_at) order by x.created_at), '[]'::jsonb)
      from (
        select ac.id, ac.agent_key, ag.display_name as agent_name, ac.task_id, ac.kind, ac.target_kind,
               ac.target_id, ac.preview, ac.created_at, ac.expires_at
        from private.agent_actions ac
        join private.agents ag on ag.key = ac.agent_key
        where ac.status = 'proposed' and ac.expires_at > now()
        order by ac.created_at
        limit 200
      ) x),
    'approvalCount', (select count(*) from private.agent_actions ac where ac.status = 'proposed' and ac.expires_at > now()),
    'awaitingSessionCount', (select count(*) from private.agent_tasks t where t.status = 'awaiting_session'));
end;
$$;
