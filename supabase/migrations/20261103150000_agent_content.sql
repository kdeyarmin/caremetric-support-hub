-- The Content Marketer: the AI team's agent for the help center's public articles. CareMetric has no blog and no articles written
-- for search, and the help center's public pages were invisible to crawlers. Once a week (Tuesdays) the agent picks one topic from
-- a curated backlog in the Hub server's code, asks the model for one article, checks it in code against the CareMetric fact sheet
-- (docs/GTM_FACTS.md) and proposes it to the owner. Approving the proposal publishes it as a public help-center article. Once a
-- month it also emails the owner directory listings and partnership pitches to send personally; nothing is sent to anyone else.
--
-- Every article is an action of the new kind content.publish aimed at a content_item (its address, the slug). Its input is the
-- exact article the owner reads in the preview, and the publishing operation below reads that stored input, never anything the
-- server hands it, so only the approved text can be published. An article is published only with the owner's approval: one that
-- was approved on its own (an agent on Act with the kind listed) is refused.
--
-- Boundary (the same closed shape as the rest of the AI team):
--   * no new table; the two new operations are security definers with a pinned empty search path that refuse every session user
--     except hub_app_server;
--   * the state read returns topic keys, slugs, statuses and counts of inbox conversations by product and inquiry type, never a
--     message, a subject or a contact;
--   * the publication is authored by the CareMetric AI Assistant profile (a1a00000-a1a0-4000-8000-000000000001) and approved by the
--     owner who decided the action, with an audit event.

-- ---------------------------------------------------------------------------------------
-- 1. The action kind and its target. The two checks are widened, never narrowed: every kind and target kind the table allows
--    today is kept (read from the constraints themselves, so a kind another change added before this one survives), and the
--    statement refuses to run if the kinds every server relies on cannot be read.
-- ---------------------------------------------------------------------------------------
do $$
declare
  v_kinds text[];
  v_targets text[];
begin
  select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_kinds
  from pg_constraint c cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') m
  where c.conrelid = 'private.agent_actions'::regclass and c.conname = 'agent_actions_kind_check';
  select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_targets
  from pg_constraint c cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') m
  where c.conrelid = 'private.agent_actions'::regclass and c.conname = 'agent_actions_target_kind_check';
  if not v_kinds @> array['communication.reply', 'communication.note', 'communication.update', 'incident.open', 'incident.resolve', 'import.run']
    or not v_targets @> array['communication', 'probe_target', 'import_source']
    or exists (select 1 from unnest(v_kinds || v_targets) value where value !~ '^[a-z][a-z0-9_.]{1,60}$') then
    raise exception 'The agent action kinds could not be read' using errcode = '55000';
  end if;
  execute format('alter table private.agent_actions drop constraint agent_actions_kind_check, add constraint agent_actions_kind_check check (kind in (%s))',
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_kinds || array['content.publish']) as k) x));
  execute format('alter table private.agent_actions drop constraint agent_actions_target_kind_check, add constraint agent_actions_target_kind_check check (target_kind in (%s))',
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_targets || array['content_item']) as k) x));
end $$;

-- An article carries exactly these facts and nothing else: its address, the product it is published under, the backlog topic, its
-- kind, its title, its description and its Markdown body (the preview is built from the same values). Its target is its address.
-- No HTML can be stored, a regulation article carries the "not legal advice" line, and a missing fact fails the check (coalesce)
-- instead of passing as unknown. The server's own checks (server/agents/content/validate.mjs) are stricter; these are the floor.
alter table private.agent_actions add constraint agent_actions_content_publish_check check (
  kind <> 'content.publish' or coalesce(
    target_kind = 'content_item'
    and (input - array['slug', 'product', 'topic', 'kind', 'title', 'description', 'body', 'promptVersion']) = '{}'::jsonb
    and jsonb_typeof(input -> 'slug') = 'string' and jsonb_typeof(input -> 'title') = 'string'
    and jsonb_typeof(input -> 'description') = 'string' and jsonb_typeof(input -> 'body') = 'string'
    and target_id = input ->> 'slug'
    and target_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(target_id) between 3 and 80
    and input ->> 'product' in ('carebase', 'caremetric-intel', 'advisors')
    and input ->> 'kind' in ('regulation', 'marketing')
    and coalesce(input ->> 'topic', '') ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(input ->> 'topic') <= 80
    and char_length(input ->> 'title') between 10 and 120 and (input ->> 'title') !~ '[<>\n]'
    and char_length(input ->> 'description') between 50 and 200 and (input ->> 'description') !~ '[<>\n]'
    and char_length(input ->> 'body') between 500 and 6000 and (input ->> 'body') !~* '<[a-z/!?]'
    and (input ->> 'kind' <> 'regulation' or strpos(input ->> 'body', 'not legal advice') > 0)
    and (not (input ? 'promptVersion') or coalesce(input ->> 'promptVersion', '') ~ '^[a-z0-9.-]{1,20}$'), false));

-- One live article per address and per topic, whichever task proposed it: a proposal waiting for the owner, an approved one and a
-- published one all hold their address and topic; a rejected, expired or failed one lets go.
create unique index agent_actions_content_publish_slug on private.agent_actions ((input ->> 'slug'))
  where kind = 'content.publish' and status in ('proposed', 'approved', 'auto_approved', 'executing', 'executed');
create unique index agent_actions_content_publish_topic on private.agent_actions ((input ->> 'topic'))
  where kind = 'content.publish' and status in ('proposed', 'approved', 'auto_approved', 'executing', 'executed');

-- ---------------------------------------------------------------------------------------
-- 2. What the agent reads to choose a topic: per backlog topic, its strongest article action (published, then waiting, then the
--    latest other), which of the given addresses another content item already uses, how many inbox conversations each product and
--    inquiry type had in the last 90 days (counts only: the text never leaves the inbox) and the months whose outreach email is
--    recorded (a failed delivery is not recorded until its three tries are used up, so the next run tries again).
-- ---------------------------------------------------------------------------------------
create function private.agent_content_state(p_slugs text[] default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_slugs is not null and (cardinality(p_slugs) > 100
    or exists (select 1 from unnest(p_slugs) as s(v) where v is null or v !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v) > 80)) then
    raise exception 'Choose up to 100 article addresses.' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'generatedAt', now(),
    'articles', coalesce((
      select jsonb_agg(jsonb_build_object('topic', x.topic, 'slug', x.slug, 'product', x.product, 'status', x.status, 'at', x.at) order by x.at desc, x.topic)
      from (
        select distinct on (a.input ->> 'topic') a.input ->> 'topic' as topic, a.input ->> 'slug' as slug, a.input ->> 'product' as product, a.status,
          coalesce(a.executed_at, a.decided_at, a.created_at) as at
        from private.agent_actions a
        where a.kind = 'content.publish'
        order by a.input ->> 'topic',
          case when a.status = 'executed' then 0 when a.status in ('proposed', 'approved', 'auto_approved', 'executing') then 1 else 2 end,
          a.created_at desc, a.id
      ) x), '[]'::jsonb),
    'takenSlugs', coalesce((
      select jsonb_agg(i.content_key order by i.content_key) from hub.content_items i where i.content_key = any (coalesce(p_slugs, array[]::text[]))), '[]'::jsonb),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object('product', q.product, 'inquiryType', q.inquiry_type, 'conversations', q.conversations) order by q.product, q.inquiry_type)
      from (
        select coalesce(p.slug, 'none') as product, c.inquiry_type, count(*)::integer as conversations
        from private.communications c left join hub.products p on p.id = c.product_id
        where c.created_at >= now() - interval '90 days'
        group by 1, 2
      ) q), '[]'::jsonb),
    'outreachMonths', coalesce((
      select jsonb_agg(distinct substring(n.dedupe_key from 18))
      from private.owner_notifications n
      where n.dedupe_key ~ '^content:outreach:[0-9]{4}-[0-9]{2}$' and n.created_at >= now() - interval '70 days'
        and (n.status <> 'failed' or n.attempts >= 3)), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------------------
-- 3. Publishing one approved article, for the execution that is carrying the action out right now. It reads the action's own input
--    and answers with an outcome:
--      published          a new public article (item, approved revision 1, a publication to the product for every visitor);
--      already_published  the address already holds this agent's article (a retry after a restart): nothing new is written;
--      approval_required  the action was approved on its own, and an article is only published with the owner's approval;
--      slug_taken         another content item already uses the address;
--      product_unavailable the product is retired or closed to support.
--    Only the first writes anything. The author is the CareMetric AI Assistant; the approval is the owner's decision on the action
--    (who and when), recorded on the revision and the publication and in an audit event.
-- ---------------------------------------------------------------------------------------
create function private.agent_content_publish(p_action_id uuid, p_execution integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_ai constant uuid := 'a1a00000-a1a0-4000-8000-000000000001';
  v_slug text;
  v_item hub.content_items%rowtype;
  v_product hub.products%rowtype;
  v_revision uuid;
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
    return jsonb_build_object('outcome', 'approval_required');
  end if;
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
      'action', v_action.id, 'approvedBy', v_action.decided_by),
    encode(sha256(convert_to(v_action.input ->> 'body', 'UTF8')), 'hex'),
    'agent:' || coalesce(v_action.input ->> 'promptVersion', 'content'),
    'approved', v_ai, v_action.decided_by, v_action.decided_at)
  returning id into v_revision;
  insert into hub.content_publications (item_id, revision_id, product_id, audience, route_pattern, published_by, published_at)
  values (v_item.id, v_revision, v_product.id, array['all'], null, v_action.decided_by, now());
  insert into private.audit_events (actor_id, action, entity_type, entity_id, product_id, metadata)
  values (v_ai, 'content.published', 'content_item', v_item.id, v_product.id,
    jsonb_build_object('agent', v_action.agent_key, 'action', v_action.id, 'slug', v_slug, 'topic', v_action.input ->> 'topic', 'approvedBy', v_action.decided_by));
  return jsonb_build_object('outcome', 'published', 'slug', v_slug, 'itemId', v_item.id, 'revisionId', v_revision);
end;
$$;

revoke all on function private.agent_content_state(text[]), private.agent_content_publish(uuid, integer)
  from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.agent_content_state(text[]), private.agent_content_publish(uuid, integer) to hub_app_server;

-- ---------------------------------------------------------------------------------------
-- 4. The agent, paused and in Propose: it drafts, the owner approves. The weekly schedule fires every morning at 07:45 Eastern and
--    the server's handler writes only on Tuesdays (an interval schedule is limited to a day); the outreach schedule fires every
--    morning at 08:05 Eastern and writes once a month, from the first Wednesday on. "Run now" works on any day. Seeding is
--    idempotent: a row the owner already changed is left as it is, and a setting is added only where it is missing.
-- ---------------------------------------------------------------------------------------
insert into private.agents (key, display_name, role_summary, status, autonomy, model_tier, daily_budget_cents, tool_allowlist, config)
values ('content_marketer', 'Content Marketer',
  'Writes one help-center article a week from a curated list of topics, checked against the CareMetric fact sheet, for you to approve before it is published. Once a month it emails you directory listings and partnership pitches to send yourself.',
  'paused', 'propose', 'draft', 150, array['get_content_state', 'propose_article', 'notify_owner'],
  '{"effort": "medium", "auto_approve_kinds": []}'::jsonb)
on conflict (key) do nothing;

update private.agents set config = '{"effort": "medium", "auto_approve_kinds": []}'::jsonb || config
where key = 'content_marketer' and not (config ? 'effort' and config ? 'auto_approve_kinds');

insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values
  ('content_marketer', 'content.weekly', 'daily', null, '07:45', 'America/New_York', false,
    private.agent_schedule_next('daily', null, '07:45', 'America/New_York', now(), null)),
  ('content_marketer', 'content.outreach', 'daily', null, '08:05', 'America/New_York', false,
    private.agent_schedule_next('daily', null, '08:05', 'America/New_York', now(), null))
on conflict (agent_key, task_kind) do nothing;
