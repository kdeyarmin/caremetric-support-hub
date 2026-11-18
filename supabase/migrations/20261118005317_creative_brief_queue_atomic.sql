-- Record automated creative briefs and their drafting tasks atomically. No new permissions or autonomous approvals.
create or replace function private.creative_brief_create(p_brief jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_status text;
  v_facts jsonb := coalesce(p_brief -> 'facts', '{}'::jsonb);
begin
  perform private.require_hub_app_server();
  if jsonb_typeof(p_brief) <> 'object' or jsonb_typeof(v_facts) <> 'object'
    or (v_facts <> '{}'::jsonb and coalesce(p_brief ->> 'source', '') not in ('data.county', 'data.release', 'observance')) then
    raise exception 'Invalid brief.' using errcode = '22023';
  end if;
  insert into private.creative_briefs (product, goal, audience, offer_code, platforms, formats, video_lengths, angle, source, plan_ref, request_key,
    parent_asset_id, revision_note, facts)
  values (p_brief ->> 'product', p_brief ->> 'goal', p_brief ->> 'audience', nullif(p_brief ->> 'offerCode', ''),
    array(select jsonb_array_elements_text(coalesce(p_brief -> 'platforms', '[]'))),
    coalesce(nullif(array(select jsonb_array_elements_text(coalesce(p_brief -> 'formats', '[]'))), array[]::text[]), array['static']),
    array(select jsonb_array_elements_text(coalesce(p_brief -> 'videoLengths', '[]'))),
    coalesce(p_brief ->> 'angle', ''), p_brief ->> 'source', nullif(p_brief ->> 'planRef', ''), p_brief ->> 'requestKey',
    nullif(p_brief ->> 'parentAssetId', '')::uuid, coalesce(p_brief ->> 'revisionNote', ''), v_facts)
  on conflict (request_key) do nothing
  returning id, status into v_id, v_status;
  if v_id is null then
    select id, status into v_id, v_status from private.creative_briefs where request_key = p_brief ->> 'requestKey';
    return jsonb_build_object('id', v_id, 'created', false, 'status', v_status);
  end if;
  -- A process can stop between creating a brief and enqueueing its draft. Keep both in this transaction;
  -- the caller's enqueue is harmless because the task request key is unique.
  perform private.agent_task_enqueue('creative_director', 'creative.request', 'creative:brief:' || v_id::text,
    jsonb_build_object('briefId', v_id), 5, now(), 'agent', 'creative.brief', false);
  return jsonb_build_object('id', v_id, 'created', true, 'status', v_status);
end;
$$;

