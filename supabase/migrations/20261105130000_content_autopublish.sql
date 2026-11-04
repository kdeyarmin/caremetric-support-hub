-- Article publishing on its own. The owner chose (2026-11-04) to let the Content Marketer publish articles that pass the content checks
-- without asking, after a supervised week (the "articles" autonomy step adds content.publish to its list). Until now publishing refused
-- any article nobody approved. This replaces the publishing operation so that an article approved automatically is published too, but
-- only while the owner has handed article publishing over: the Content Marketer must be active, on Act and trusted with
-- content.publish when it is published, not only when it was proposed. The owner's own approvals work exactly as before. An article
-- published automatically records the AI assistant as its approver (under the owner's standing hand-over) and says so in its
-- variables and its audit row; the server re-checks every article against the content rules before asking the database to publish it.
create or replace function private.agent_content_publish(p_action_id uuid, p_execution integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_ai constant uuid := 'a1a00000-a1a0-4000-8000-000000000001';
  v_slug text;
  v_item hub.content_items%rowtype;
  v_product hub.products%rowtype;
  v_revision uuid;
  v_agent private.agents%rowtype;
  v_approver uuid;
  v_approved_at timestamptz;
begin
  perform private.require_hub_app_server();
  select * into v_action from private.agent_actions where id = p_action_id for update;
  if not found or v_action.kind <> 'content.publish' then
    raise exception 'Unknown article proposal.' using errcode = 'P0002';
  end if;
  if v_action.status <> 'executing' or (p_execution is not null and v_action.executions <> p_execution) then
    raise exception 'That article is not being published.' using errcode = '55000';
  end if;
  if v_action.decided_by is null or v_action.decided_at is null then
    -- Approved automatically: only while the owner has handed article publishing over (the Content Marketer active, on Act and
    -- trusted with content.publish), checked now, not only when the article was proposed.
    select * into v_agent from private.agents where key = v_action.agent_key;
    if v_agent.status is distinct from 'active' or v_agent.autonomy is distinct from 'act'
      or jsonb_typeof(v_agent.config -> 'auto_approve_kinds') is distinct from 'array'
      or not ((v_agent.config -> 'auto_approve_kinds') ? 'content.publish') then
      return jsonb_build_object('outcome', 'approval_required');
    end if;
  end if;
  -- The owner approved it, or (automatically) the AI assistant did under the owner's standing hand-over.
  v_approver := coalesce(v_action.decided_by, v_ai);
  v_approved_at := coalesce(v_action.decided_at, now());
  v_slug := v_action.input ->> 'slug';
  -- One publication of an address at a time, so two servers cannot both find it free.
  perform pg_advisory_xact_lock(hashtextextended('content:' || v_slug, 0));
  select * into v_item from hub.content_items where content_key = v_slug;
  if found then
    if v_item.created_by = v_ai and exists (
      select 1 from hub.content_revisions r where r.item_id = v_item.id and r.variables ->> 'author' = 'content_marketer') then
      return jsonb_build_object('outcome', 'already_published', 'slug', v_slug, 'itemId', v_item.id);
    end if;
    return jsonb_build_object('outcome', 'slug_taken', 'slug', v_slug);
  end if;
  select * into v_product from hub.products p
  where p.slug = v_action.input ->> 'product' and p.status <> 'retired' and p.support_enabled;
  if not found then
    return jsonb_build_object('outcome', 'product_unavailable', 'slug', v_slug);
  end if;

  insert into hub.content_items (content_key, kind, status, access_level, owner_product_id, owner_team, default_locale, source_system, created_by)
  values (v_slug, 'article', 'published', 'public', v_product.id, 'CareMetric Marketing', 'en-US', 'support_hub', v_ai)
  returning * into v_item;
  insert into hub.content_revisions (item_id, revision_no, locale, title, summary, body_markdown, variables, source_hash, source_version,
    review_state, created_by, approved_by, approved_at)
  values (v_item.id, 1, 'en-US', v_action.input ->> 'title', v_action.input ->> 'description', v_action.input ->> 'body',
    jsonb_build_object('author', 'content_marketer', 'agent', v_action.agent_key, 'topic', v_action.input ->> 'topic', 'kind', v_action.input ->> 'kind',
      'action', v_action.id, 'approvedBy', v_action.decided_by, 'approval', case when v_action.decided_by is null then 'automatic' else 'owner' end),
    encode(sha256(convert_to(v_action.input ->> 'body', 'UTF8')), 'hex'),
    'agent:' || coalesce(v_action.input ->> 'promptVersion', 'content'),
    'approved', v_ai, v_approver, v_approved_at)
  returning id into v_revision;
  insert into hub.content_publications (item_id, revision_id, product_id, audience, route_pattern, published_by, published_at)
  values (v_item.id, v_revision, v_product.id, array['all'], null, v_approver, now());
  insert into private.audit_events (actor_id, action, entity_type, entity_id, product_id, metadata)
  values (v_ai, 'content.published', 'content_item', v_item.id, v_product.id,
    jsonb_build_object('agent', v_action.agent_key, 'action', v_action.id, 'slug', v_slug, 'topic', v_action.input ->> 'topic', 'approvedBy', v_action.decided_by,
      'approval', case when v_action.decided_by is null then 'automatic' else 'owner' end));
  return jsonb_build_object('outcome', 'published', 'slug', v_slug, 'itemId', v_item.id, 'revisionId', v_revision);
end;
$$;

revoke all on function private.agent_content_publish(uuid, integer) from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.agent_content_publish(uuid, integer) to hub_app_server;
