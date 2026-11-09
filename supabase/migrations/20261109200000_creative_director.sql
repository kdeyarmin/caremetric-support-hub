-- The Creative Director: a member of the AI team that turns the marketing plans (the Social Media Manager's weekly plan, the
-- Marketing Manager's content briefs and the owner's own briefs) into finished, on-brand, compliant ad creative: static images and
-- short videos for Meta, LinkedIn, Google display and YouTube. Every asset passes code checks (server/agents/creative/compliance.mjs)
-- before the owner sees it; one that fails is blocked and never reaches the owner. The owner approves, rejects or asks for changes; an
-- approved asset is handed to the Social Media Manager, and a rejection note becomes a revision brief. Every week it learns which hooks,
-- layouts and lengths worked, by joining ad results and leads on utm_content = the asset's id.
--
-- Nothing here posts, sends or spends anything. The agent starts paused, in Propose, trusted with nothing; two autonomy steps (both off)
-- let the owner hand over, after a supervised week each, approving assets that passed every check with no warning, and retiring tired
-- creative. An asset with a compliance warning always waits for the owner: the database refuses an automatically approved one.
--
-- Boundary (the same closed shape as the AI team control plane in 20261102120000): every table has row level security and NO privilege
-- for any browser, service or server role, and no policy. The Hub server reaches them only through the private.creative_* security
-- definer operations below, each refusing every session user but hub_app_server; the owner reads and changes them only through the
-- hub.* operations below, which authorize the owner's SMS session themselves (reads need the administrator session, changes the command
-- session). Finished files are kept in a private table (private.creative_files) rather than Storage, because the server renders on its own
-- clock without the owner's session and Storage has no session-less path for it; only an approved asset is ever served publicly, under an
-- unguessable token, so Meta and LinkedIn can fetch the image the owner approved.

-- One row per product. The brand name is always "CareMetric". Colors, fonts, logo and voice start BLANK on purpose: a blank field uses the
-- product's own brand theme (server/agents/creative/themes.mjs: the colors, type and logo of its app and emails), and a field the owner
-- sets on the Creative screen replaces the theme's.
create table private.brand_kits (
  product text primary key check (product in ('carebase', 'caremetric-intel')),
  brand_name text not null default 'CareMetric' check (brand_name = 'CareMetric'),
  logo_file_id uuid,
  primary_color text check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_color text check (secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color text check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  text_color text check (text_color ~ '^#[0-9A-Fa-f]{6}$'),
  background_color text check (background_color ~ '^#[0-9A-Fa-f]{6}$'),
  heading_font text check (heading_font ~ '^[A-Za-z0-9 ]{2,40}$'),
  body_font text check (body_font ~ '^[A-Za-z0-9 ]{2,40}$'),
  voice_notes text not null default '' check (char_length(voice_notes) <= 2000),
  required_disclaimers text[] not null default '{}' check (cardinality(required_disclaimers) <= 10),
  banned_phrases text[] not null default '{}' check (cardinality(banned_phrases) <= 100),
  -- The presenter and voice a HeyGen video uses (Settings → Creative: HeyGen); without them the internal renderer is used.
  video_avatar_id text check (video_avatar_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  video_voice_id text check (video_voice_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  captions_default boolean not null default true,
  version integer not null default 1 check (version >= 1),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

-- What to make, for whom and where. An audience describes a business, never a person's health, so it may not contain any of the
-- health-attribute words below (whole words, any case, singular or plural): diagnosis, condition, disease, medication, patient,
-- symptom, disability, pregnancy, cancer, diabetes, depression, HIV. An offer is named by its code, never by a price.
create table private.creative_briefs (
  id uuid primary key default gen_random_uuid(),
  product text not null check (product in ('carebase', 'caremetric-intel')),
  goal text not null check (char_length(btrim(goal)) between 1 and 500),
  audience text not null check (
    char_length(btrim(audience)) between 1 and 500
    and audience !~* '\y(diagnos[ei]s|conditions?|diseases?|medications?|patients?|symptoms?|disabilit(y|ies)|pregnanc(y|ies)|cancers?|diabetes|depression|hiv)\y'),
  offer_code text check (offer_code ~ '^[A-Z0-9]{3,30}$'),
  platforms text[] not null check (
    cardinality(platforms) between 1 and 4
    and platforms <@ array['meta', 'linkedin', 'google', 'youtube']),
  formats text[] not null default '{static}' check (cardinality(formats) between 1 and 2 and formats <@ array['static', 'video']),
  video_lengths text[] not null default '{15s}' check (cardinality(video_lengths) <= 4 and video_lengths <@ array['6s', '15s', '30s', '45-60s']),
  angle text not null default '' check (char_length(angle) <= 500),
  source text not null check (source in ('social.plan', 'growth.plan', 'sweep', 'owner', 'refresh', 'revision')),
  status text not null default 'open' check (status in ('open', 'drafting', 'done', 'cancelled', 'skipped')),
  plan_ref text check (char_length(plan_ref) between 1 and 200),
  -- A plan output, an owner's form or a rejection becomes one brief however often it is seen.
  request_key text not null unique check (char_length(request_key) between 1 and 200),
  parent_asset_id uuid,
  revision_note text not null default '' check (char_length(revision_note) <= 1000),
  result jsonb not null default '{}' check (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 4096),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index creative_briefs_product_status on private.creative_briefs (product, status);
create index creative_briefs_plan_ref on private.creative_briefs (plan_ref) where plan_ref is not null;

-- One row per finished piece of creative. A landing address carries utm_content=<the asset's id>, so a lead or an ad result can be traced
-- back to it; the database writes that address itself when the asset is stored.
create table private.creative_assets (
  id uuid primary key default gen_random_uuid(),
  brief_id uuid not null references private.creative_briefs(id) on delete restrict,
  task_id uuid references private.agent_tasks(id) on delete set null,
  product text not null check (product in ('carebase', 'caremetric-intel')),
  platform text not null check (platform in ('meta', 'linkedin', 'google', 'youtube')),
  -- The placement in server/agents/creative/specs.mjs, such as meta.feed_square or youtube.thumbnail.
  placement text not null check (placement ~ '^[a-z]+\.[a-z0-9_]{2,40}$'),
  kind text not null check (kind in ('static', 'video')),
  layout text not null check (layout in ('headline', 'stat', 'screenshot', 'quote', 'offer', 'checklist', 'split')),
  width integer not null check (width between 100 and 4000),
  height integer not null check (height between 100 and 4000),
  duration_seconds numeric(6, 2) check (duration_seconds between 0.5 and 120),
  length_key text check (length_key in ('6s', '15s', '30s', '45-60s')),
  variant_label text not null check (char_length(variant_label) between 1 and 40),
  hook_type text not null check (hook_type in ('problem', 'proof', 'offer', 'curiosity', 'demo')),
  concept text not null default '' check (char_length(concept) <= 500),
  headline text not null default '' check (char_length(headline) <= 300),
  primary_text text not null default '' check (char_length(primary_text) <= 3000),
  description text not null default '' check (char_length(description) <= 300),
  cta text not null default '' check (char_length(cta) <= 40),
  landing_url text check (char_length(landing_url) <= 2000 and landing_url ~ '^https://' and position('utm_content=' in landing_url) > 0),
  alt_text text not null default '' check (char_length(alt_text) <= 500),
  -- WebVTT for a video; the same lines are burned into the picture.
  captions text not null default '' check (char_length(captions) <= 20000),
  -- What the layout shows besides the copy: a statistic, checklist items, a quote, a video's beats. CareMetric's own words only.
  overlay jsonb not null default '{}' check (jsonb_typeof(overlay) = 'object' and pg_column_size(overlay) <= 16384),
  provider text not null default 'internal' check (provider in ('internal', 'heygen')),
  status text not null default 'draft'
    check (status in ('draft', 'rendering', 'ready', 'blocked', 'proposed', 'approved', 'rejected', 'expired', 'live', 'retired', 'failed')),
  compliance jsonb not null default '{}' check (jsonb_typeof(compliance) = 'object' and pg_column_size(compliance) <= 8192),
  performance jsonb not null default '{}' check (jsonb_typeof(performance) = 'object' and pg_column_size(performance) <= 4096),
  revision_notes text not null default '' check (char_length(revision_notes) <= 1000),
  action_id uuid references private.agent_actions(id) on delete set null,
  -- Set only while the asset is approved or live: the unguessable name under which Meta and LinkedIn may fetch it.
  public_token text unique check (public_token ~ '^[0-9a-f]{64}$'),
  content_type text check (content_type in ('image/png', 'video/mp4')),
  file_bytes integer check (file_bytes > 0),
  render_attempts integer not null default 0 check (render_attempts between 0 and 10),
  render_job jsonb check (jsonb_typeof(render_job) = 'object' and pg_column_size(render_job) <= 2048),
  render_error text check (render_error ~ '^[a-z][a-z_]{0,59}$'),
  render_started_at timestamptz,
  rendered_at timestamptz,
  proposed_at timestamptz,
  approved_at timestamptz,
  live_at timestamptz,
  live_ref text check (char_length(live_ref) <= 200),
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status in ('approved', 'live')) = (public_token is not null)),
  check (kind = 'static' or duration_seconds is not null or status in ('draft', 'rendering', 'blocked', 'failed'))
);
create index creative_assets_brief on private.creative_assets (brief_id);
create index creative_assets_product_platform_status on private.creative_assets (product, platform, status);
create index creative_assets_status_created on private.creative_assets (status, created_at);
create index creative_assets_render_started on private.creative_assets (render_started_at) where render_started_at is not null;
-- A retried drafting task stores each variant once.
create unique index creative_assets_once_per_brief on private.creative_assets (brief_id, variant_label, placement);
alter table private.creative_briefs add constraint creative_briefs_parent_fk foreign key (parent_asset_id) references private.creative_assets(id) on delete set null;

-- The finished files, and the owner's logo and product screenshots. A screenshot is kept only with the owner's attestation that it shows
-- no patient, resident or personal information.
create table private.creative_files (
  id uuid primary key default gen_random_uuid(),
  product text not null check (product in ('carebase', 'caremetric-intel')),
  kind text not null check (kind in ('asset', 'logo', 'screenshot')),
  asset_id uuid references private.creative_assets(id) on delete cascade,
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'video/mp4')),
  bytes bytea not null check (octet_length(bytes) between 1 and 62914560),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  label text not null default '' check (char_length(label) <= 120),
  phi_free_attested boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  check ((kind = 'asset') = (asset_id is not null)),
  check (kind <> 'screenshot' or phi_free_attested),
  check (kind = 'asset' or (content_type in ('image/png', 'image/jpeg') and octet_length(bytes) <= 5242880))
);
create unique index creative_files_one_per_asset on private.creative_files (asset_id) where asset_id is not null;
create index creative_files_brand on private.creative_files (product, kind) where kind <> 'asset';
alter table private.brand_kits add constraint brand_kits_logo_fk foreign key (logo_file_id) references private.creative_files(id) on delete set null;

-- What worked and what did not, one verdict per pattern, so the next brief starts from evidence. A pattern's verdict changes as the
-- evidence does.
create table private.creative_learnings (
  id uuid primary key default gen_random_uuid(),
  product text not null check (product in ('carebase', 'caremetric-intel')),
  platform text not null check (platform in ('meta', 'linkedin', 'google', 'youtube')),
  pattern_kind text not null check (pattern_kind in ('hook', 'format', 'length', 'layout', 'color')),
  pattern_value text not null check (char_length(pattern_value) between 1 and 120),
  verdict text not null check (verdict in ('win', 'lose', 'neutral')),
  samples integer not null default 0 check (samples >= 0),
  score numeric(8, 3) not null default 0,
  evidence jsonb not null default '{}' check (jsonb_typeof(evidence) = 'object' and pg_column_size(evidence) <= 2048),
  observed_at timestamptz not null default now(),
  unique (product, platform, pattern_kind, pattern_value)
);

alter table private.brand_kits enable row level security;
alter table private.creative_briefs enable row level security;
alter table private.creative_assets enable row level security;
alter table private.creative_files enable row level security;
alter table private.creative_learnings enable row level security;
revoke all on private.brand_kits, private.creative_briefs, private.creative_assets, private.creative_files, private.creative_learnings
  from public, anon, authenticated, service_role, hub_app_server;

-- The two brand kits start BLANK (each product's brand theme): only the defaults above.
insert into private.brand_kits (product) values ('carebase'), ('caremetric-intel') on conflict (product) do nothing;

-- The Creative Director, paused, in Propose, trusted with nothing. Concepts and final copy use the quality tier, variants the draft tier.
insert into private.agents (key, display_name, role_summary, status, autonomy, model_tier, daily_budget_cents, tool_allowlist, config)
values ('creative_director', 'Creative Director',
  'Turns marketing plans into finished, on-brand, compliant ad creative (images and short videos) for your approval, hands what you approve to the Social Media Manager, and learns from how it performs. Nothing is published until you approve it.',
  'paused', 'propose', 'quality', 300,
  array['creative_brief', 'creative_render_static', 'creative_render_video', 'creative_compliance_check', 'propose_creative', 'creative_report', 'notify_owner'],
  '{"auto_approve_kinds": [], "effort": "medium"}'::jsonb)
on conflict (key) do nothing;

insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at) values
  ('creative_director', 'creative.render', 'interval', 600, null, 'America/New_York', false, now()),
  ('creative_director', 'creative.plan', 'daily', null, '08:30', 'America/New_York', false,
   private.agent_schedule_next('daily', null, '08:30', 'America/New_York', now(), null)),
  ('creative_director', 'creative.refresh', 'daily', null, '09:30', 'America/New_York', false,
   private.agent_schedule_next('daily', null, '09:30', 'America/New_York', now(), null)),
  ('creative_director', 'creative.report', 'daily', null, '09:45', 'America/New_York', false,
   private.agent_schedule_next('daily', null, '09:45', 'America/New_York', now(), null))
on conflict (agent_key, task_kind) do nothing;

-- The action kinds and targets, widened (read from the constraints themselves, as every earlier change did), never narrowed.
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
  if not v_kinds @> array['communication.reply', 'email.send', 'content.publish', 'growth.message', 'growth.content', 'email.external', 'social.post', 'social.ad_create']
    or not v_targets @> array['communication', 'billing_account', 'content_item', 'growth_message', 'growth_content', 'external_email', 'social_post', 'social_adset']
    or exists (select 1 from unnest(v_kinds || v_targets) value where value !~ '^[a-z][a-z0-9_.]{1,60}$') then
    raise exception 'The agent action kinds could not be read' using errcode = '55000';
  end if;
  execute format('alter table private.agent_actions drop constraint agent_actions_kind_check, add constraint agent_actions_kind_check check (kind in (%s))',
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_kinds || array['creative.asset', 'creative.asset_review', 'creative.retire']) as k) x));
  execute format('alter table private.agent_actions drop constraint agent_actions_target_kind_check, add constraint agent_actions_target_kind_check check (target_kind in (%s))',
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_targets || array['creative_asset']) as k) x));
end $$;

-- Creative actions belong to the Creative Director and name the asset they act on. An asset with a compliance warning
-- (creative.asset_review) is never automatic.
alter table private.agent_actions add constraint agent_actions_creative_check check (
  kind not like 'creative.%' or coalesce(
    agent_key = 'creative_director'
    and target_kind = 'creative_asset'
    and target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (kind <> 'creative.asset_review' or status <> 'auto_approved'), false));

insert into private.agent_autonomy_steps (category, label, requires_feature, changes) values
  ('creative_assets', 'Creative approvals', 'platform.agents.creative.v1',
    '[{"agent": "creative_director", "config_key": "auto_approve_kinds", "values": ["creative.asset"]}]'),
  ('creative_retire', 'Retiring tired creative', 'platform.agents.creative.v1',
    '[{"agent": "creative_director", "config_key": "auto_approve_kinds", "values": ["creative.retire"]}]')
on conflict (category) do nothing;

-- ---- Helpers (no role may call them) -------------------------------------------------------------------------------------------------

create function private.creative_today_start() returns timestamptz
language sql stable set search_path = '' as $$
  select (date_trunc('day', now() at time zone 'America/New_York')) at time zone 'America/New_York';
$$;

create function private.creative_token() returns text
language sql volatile set search_path = '' as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

create function private.creative_brand_kit_json(p_kit private.brand_kits) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('product', p_kit.product, 'brandName', p_kit.brand_name, 'logoFileId', p_kit.logo_file_id,
    'primaryColor', p_kit.primary_color, 'secondaryColor', p_kit.secondary_color, 'accentColor', p_kit.accent_color,
    'textColor', p_kit.text_color, 'backgroundColor', p_kit.background_color, 'headingFont', p_kit.heading_font, 'bodyFont', p_kit.body_font,
    'voiceNotes', p_kit.voice_notes, 'requiredDisclaimers', to_jsonb(p_kit.required_disclaimers), 'bannedPhrases', to_jsonb(p_kit.banned_phrases),
    'videoAvatarId', p_kit.video_avatar_id, 'videoVoiceId', p_kit.video_voice_id, 'captionsDefault', p_kit.captions_default,
    'version', p_kit.version, 'updatedAt', p_kit.updated_at,
    'screenshots', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'label', f.label, 'contentType', f.content_type, 'bytes', octet_length(f.bytes)) order by f.created_at)
      from private.creative_files f where f.product = p_kit.product and f.kind = 'screenshot'), '[]'::jsonb));
$$;

create function private.creative_asset_json(p_asset private.creative_assets) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p_asset.id, 'briefId', p_asset.brief_id, 'product', p_asset.product, 'platform', p_asset.platform,
    'placement', p_asset.placement, 'kind', p_asset.kind, 'layout', p_asset.layout, 'width', p_asset.width, 'height', p_asset.height,
    'durationSeconds', p_asset.duration_seconds, 'lengthKey', p_asset.length_key, 'variantLabel', p_asset.variant_label, 'hookType', p_asset.hook_type,
    'concept', p_asset.concept, 'headline', p_asset.headline, 'primaryText', p_asset.primary_text, 'description', p_asset.description, 'cta', p_asset.cta,
    'landingUrl', p_asset.landing_url, 'altText', p_asset.alt_text, 'captions', p_asset.captions, 'overlay', p_asset.overlay, 'provider', p_asset.provider,
    'status', p_asset.status, 'compliance', p_asset.compliance, 'performance', p_asset.performance, 'revisionNotes', p_asset.revision_notes,
    'actionId', p_asset.action_id, 'contentType', p_asset.content_type, 'fileBytes', p_asset.file_bytes, 'renderError', p_asset.render_error,
    'renderAttempts', p_asset.render_attempts, 'createdAt', p_asset.created_at, 'updatedAt', p_asset.updated_at, 'renderedAt', p_asset.rendered_at,
    'approvedAt', p_asset.approved_at, 'liveAt', p_asset.live_at, 'retiredAt', p_asset.retired_at);
$$;

create function private.creative_brief_json(p_brief private.creative_briefs) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p_brief.id, 'product', p_brief.product, 'goal', p_brief.goal, 'audience', p_brief.audience, 'offerCode', p_brief.offer_code,
    'platforms', to_jsonb(p_brief.platforms), 'formats', to_jsonb(p_brief.formats), 'videoLengths', to_jsonb(p_brief.video_lengths), 'angle', p_brief.angle,
    'source', p_brief.source, 'status', p_brief.status, 'planRef', p_brief.plan_ref, 'parentAssetId', p_brief.parent_asset_id,
    'revisionNote', p_brief.revision_note, 'result', p_brief.result, 'createdAt', p_brief.created_at, 'updatedAt', p_brief.updated_at);
$$;

-- The address an asset sends people to: the product page it was drafted for, with the asset's own tracking (before any #fragment).
create function private.creative_landing(p_base text, p_platform text, p_brief uuid, p_asset uuid) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_path text := split_part(p_base, '#', 1);
  v_fragment text := case when position('#' in p_base) > 0 then '#' || split_part(p_base, '#', 2) else '' end;
begin
  if p_base is null or p_base !~ '^https://[A-Za-z0-9.-]+(/[^\s?#<>"]*)?(#[A-Za-z0-9_-]*)?$' or char_length(p_base) > 500 then
    return null;
  end if;
  return v_path || '?utm_source=' || p_platform || '&utm_medium=paid&utm_campaign=creative-' || left(p_brief::text, 8)
    || '&utm_content=' || p_asset::text || v_fragment;
end;
$$;

revoke all on function private.creative_today_start(), private.creative_token(), private.creative_brand_kit_json(private.brand_kits),
  private.creative_asset_json(private.creative_assets), private.creative_brief_json(private.creative_briefs),
  private.creative_landing(text, text, uuid, uuid)
  from public, anon, authenticated, service_role, hub_app_server;

-- ---- The owner's decisions ----------------------------------------------------------------------------------------------------------

-- A decision on a proposed asset updates the asset in the same transaction: rejected (keeping the owner's note) or expired. A rejection by
-- the owner with a note becomes a revision brief and a task to draft it, so "request changes" needs nothing else. A cancelled task's
-- proposals are rejected by the system (no decider) and start no revision.
create function private.creative_action_decided() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_asset private.creative_assets%rowtype;
  v_brief private.creative_briefs%rowtype;
  v_note text;
  v_new uuid;
begin
  if new.kind not in ('creative.asset', 'creative.asset_review') or new.status is not distinct from old.status
    or new.status not in ('rejected', 'expired') then
    return new;
  end if;
  select * into v_asset from private.creative_assets where id = new.target_id::uuid and action_id = new.id for update;
  if not found or v_asset.status <> 'proposed' then
    return new;
  end if;
  v_note := left(btrim(coalesce(new.decision_note, '')), 1000);
  update private.creative_assets set status = new.status,
    revision_notes = case when new.status = 'rejected' and new.decided_by is not null then v_note else revision_notes end, updated_at = now()
  where id = v_asset.id;
  if new.status = 'rejected' and new.decided_by is not null and v_note <> '' then
    select * into v_brief from private.creative_briefs where id = v_asset.brief_id;
    insert into private.creative_briefs (product, goal, audience, offer_code, platforms, formats, video_lengths, angle, source, plan_ref, request_key,
      parent_asset_id, revision_note, created_by)
    values (v_brief.product, v_brief.goal, v_brief.audience, v_brief.offer_code, array[v_asset.platform], array[v_asset.kind],
      case when v_asset.kind = 'video' then array[coalesce(v_asset.length_key, '15s')] else array[]::text[] end, v_brief.angle, 'revision',
      v_brief.plan_ref, 'revision:' || new.id::text, v_asset.id, v_note, new.decided_by)
    on conflict (request_key) do nothing
    returning id into v_new;
    if v_new is not null then
      insert into private.agent_tasks (agent_key, kind, request_key, payload, priority, due_at, source_kind, source_ref, status)
      values ('creative_director', 'creative.request', 'creative:brief:' || v_new::text, jsonb_build_object('briefId', v_new), 4, now(), 'owner',
        'revision', 'queued')
      on conflict (request_key) do nothing;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.creative_action_decided() from public, anon, authenticated, service_role, hub_app_server;
create trigger agent_actions_creative_decided after update of status on private.agent_actions
  for each row when (new.kind like 'creative.%') execute function private.creative_action_decided();

-- ---- Server operations (hub_app_server only) ----------------------------------------------------------------------------------------

-- Marketing plan output that has no creative yet: the Social Media Manager's posts and the Marketing Manager's content briefs from the
-- last p_days days, CareMetric's own words only. A plan output that already has a brief is left out.
create function private.creative_plan_inputs(p_days integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return coalesce((select jsonb_agg(x order by x ->> 'createdAt') from (
    select jsonb_build_object('ref', 'social.post:' || a.id::text, 'source', 'social.plan', 'product', a.input ->> 'product',
      'platform', a.input ->> 'platform', 'pillar', a.input ->> 'pillar', 'text', left(coalesce(a.input ->> 'message', ''), 600),
      'createdAt', a.created_at) as x
    from private.agent_actions a
    where a.agent_key = 'social_manager' and a.kind = 'social.post' and a.status in ('proposed', 'approved', 'auto_approved', 'executing', 'executed')
      and a.created_at > now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 31))
      and a.input ->> 'product' in ('carebase', 'caremetric-intel')
      and not exists (select 1 from private.creative_briefs b where b.plan_ref = 'social.post:' || a.id::text)
    union all
    select jsonb_build_object('ref', 'growth.content:' || a.id::text, 'source', 'growth.plan', 'product', a.input ->> 'product',
      'platform', null, 'pillar', 'resource', 'text', left(coalesce(a.input ->> 'title', '') || '. ' || coalesce(a.input ->> 'keyword', ''), 600),
      'createdAt', a.created_at)
    from private.agent_actions a
    where a.kind = 'growth.content' and a.status in ('approved', 'auto_approved', 'executing', 'executed')
      and a.created_at > now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 31))
      and a.input ->> 'product' in ('carebase', 'caremetric-intel')
      and not exists (select 1 from private.creative_briefs b where b.plan_ref = 'growth.content:' || a.id::text)
    limit 200) y), '[]'::jsonb);
end;
$$;

-- Records one brief, once per request key. Returns { id, created, status }.
create function private.creative_brief_create(p_brief jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_status text;
begin
  perform private.require_hub_app_server();
  if jsonb_typeof(p_brief) <> 'object' then
    raise exception 'Invalid brief.' using errcode = '22023';
  end if;
  insert into private.creative_briefs (product, goal, audience, offer_code, platforms, formats, video_lengths, angle, source, plan_ref, request_key,
    parent_asset_id, revision_note)
  values (p_brief ->> 'product', p_brief ->> 'goal', p_brief ->> 'audience', nullif(p_brief ->> 'offerCode', ''),
    array(select jsonb_array_elements_text(coalesce(p_brief -> 'platforms', '[]'))),
    coalesce(nullif(array(select jsonb_array_elements_text(coalesce(p_brief -> 'formats', '[]'))), array[]::text[]), array['static']),
    array(select jsonb_array_elements_text(coalesce(p_brief -> 'videoLengths', '[]'))),
    coalesce(p_brief ->> 'angle', ''), p_brief ->> 'source', nullif(p_brief ->> 'planRef', ''), p_brief ->> 'requestKey',
    nullif(p_brief ->> 'parentAssetId', '')::uuid, coalesce(p_brief ->> 'revisionNote', ''))
  on conflict (request_key) do nothing
  returning id, status into v_id, v_status;
  if v_id is null then
    select id, status into v_id, v_status from private.creative_briefs where request_key = p_brief ->> 'requestKey';
    return jsonb_build_object('id', v_id, 'created', false, 'status', v_status);
  end if;
  return jsonb_build_object('id', v_id, 'created', true, 'status', v_status);
end;
$$;

-- Everything drafting one brief needs: the brief, its product's brand kit (no file bytes), the asset a revision starts from with the
-- owner's note, the product's learnings and its recent headlines (so a new variant does not repeat one).
create function private.creative_brief_context(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_brief private.creative_briefs%rowtype;
  v_kit private.brand_kits%rowtype;
  v_parent private.creative_assets%rowtype;
begin
  perform private.require_hub_app_server();
  select * into v_brief from private.creative_briefs where id = p_id;
  if not found then
    return null;
  end if;
  select * into v_kit from private.brand_kits where product = v_brief.product;
  select * into v_parent from private.creative_assets where id = v_brief.parent_asset_id;
  return jsonb_build_object('brief', private.creative_brief_json(v_brief), 'brandKit', private.creative_brand_kit_json(v_kit),
    'parent', case when v_parent.id is null then null else jsonb_build_object('id', v_parent.id, 'platform', v_parent.platform, 'kind', v_parent.kind,
      'layout', v_parent.layout, 'hookType', v_parent.hook_type, 'headline', v_parent.headline, 'primaryText', v_parent.primary_text,
      'description', v_parent.description, 'cta', v_parent.cta, 'overlay', v_parent.overlay, 'lengthKey', v_parent.length_key,
      'performance', v_parent.performance, 'status', v_parent.status) end,
    'learnings', coalesce((select jsonb_agg(jsonb_build_object('platform', l.platform, 'kind', l.pattern_kind, 'value', l.pattern_value, 'verdict', l.verdict,
        'samples', l.samples, 'score', l.score) order by abs(l.score) desc, l.samples desc)
      from (select * from private.creative_learnings where product = v_brief.product and verdict <> 'neutral' order by abs(score) desc, samples desc limit 12) l), '[]'::jsonb),
    'recentHeadlines', coalesce((select jsonb_agg(h.headline) from (select headline from private.creative_assets
      where product = v_brief.product and headline <> '' order by created_at desc limit 30) h), '[]'::jsonb));
end;
$$;

-- Moves a brief along: drafting, done (with counts), skipped (with a reason code) or cancelled.
create function private.creative_brief_finish(p_id uuid, p_status text, p_result jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_status not in ('drafting', 'done', 'skipped', 'cancelled', 'open') then
    raise exception 'Invalid brief status.' using errcode = '22023';
  end if;
  update private.creative_briefs set status = p_status, result = coalesce(p_result, result), updated_at = now()
  where id = p_id and status not in ('done', 'cancelled');
  return found;
end;
$$;

-- Stores a brief's drafted variants, one row per variant and placement: `draft` to be rendered, or `blocked` (the copy failed a check;
-- kept for the record and never shown to the owner). The landing address carries the asset's own id. Returns [{ id, status, created }].
create function private.creative_drafts_save(p_brief uuid, p_task uuid, p_assets jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_brief private.creative_briefs%rowtype;
  v_item jsonb;
  v_id uuid;
  v_out jsonb := '[]'::jsonb;
  v_status text;
begin
  perform private.require_hub_app_server();
  select * into v_brief from private.creative_briefs where id = p_brief for update;
  if not found then
    raise exception 'Unknown brief.' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_assets) <> 'array' or jsonb_array_length(p_assets) > 60 then
    raise exception 'Invalid drafts.' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_assets) loop
    v_status := case when v_item -> 'compliance' ->> 'verdict' = 'block' then 'blocked' else 'draft' end;
    insert into private.creative_assets (brief_id, task_id, product, platform, placement, kind, layout, width, height, length_key, variant_label, hook_type,
      concept, headline, primary_text, description, cta, alt_text, overlay, provider, status, compliance)
    values (v_brief.id, p_task, v_brief.product, v_item ->> 'platform', v_item ->> 'placement', v_item ->> 'kind', v_item ->> 'layout',
      (v_item ->> 'width')::integer, (v_item ->> 'height')::integer, nullif(v_item ->> 'lengthKey', ''), v_item ->> 'variantLabel', v_item ->> 'hookType',
      coalesce(v_item ->> 'concept', ''), coalesce(v_item ->> 'headline', ''), coalesce(v_item ->> 'primaryText', ''), coalesce(v_item ->> 'description', ''),
      coalesce(v_item ->> 'cta', ''), coalesce(v_item ->> 'altText', ''), coalesce(v_item -> 'overlay', '{}'::jsonb), coalesce(v_item ->> 'provider', 'internal'),
      v_status, coalesce(v_item -> 'compliance', '{}'::jsonb))
    on conflict (brief_id, variant_label, placement) do nothing
    returning id into v_id;
    if v_id is null then
      select id, status into v_id, v_status from private.creative_assets
      where brief_id = v_brief.id and variant_label = v_item ->> 'variantLabel' and placement = v_item ->> 'placement';
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'status', v_status, 'created', false));
    else
      update private.creative_assets set landing_url = private.creative_landing(v_item ->> 'landingBase', platform, brief_id, id) where id = v_id;
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'status', v_status, 'created', true));
    end if;
  end loop;
  update private.creative_briefs set updated_at = now() where id = v_brief.id;
  return v_out;
end;
$$;

-- Hands out drafts to render, at most the day's cap (renders started since Eastern midnight, across every server), oldest first, only for
-- the given products. A render that stalled for 20 minutes is handed back (or failed after three tries). HeyGen jobs are polled separately.
create function private.creative_render_claim(p_limit integer, p_daily_cap integer, p_products text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today integer;
  v_room integer;
  v_claimed jsonb;
begin
  perform private.require_hub_app_server();
  update private.creative_assets set status = case when render_attempts >= 3 then 'failed' else 'draft' end,
    render_error = case when render_attempts >= 3 then 'render_stalled' else render_error end, updated_at = now()
  where status = 'rendering' and render_job is null and render_started_at < now() - interval '20 minutes';
  select count(*) into v_today from private.creative_assets where render_started_at >= private.creative_today_start();
  v_room := least(greatest(coalesce(p_limit, 1), 0), 20, greatest(coalesce(p_daily_cap, 0) - v_today, 0));
  with picked as (
    select a.id from private.creative_assets a
    where a.status = 'draft' and a.product = any(coalesce(p_products, array[]::text[]))
    order by a.created_at, a.id
    limit v_room
    for update skip locked
  ), claimed as (
    update private.creative_assets a set status = 'rendering', render_started_at = now(), render_attempts = a.render_attempts + 1, render_error = null,
      updated_at = now()
    from picked where a.id = picked.id
    returning a.*
  )
  select coalesce(jsonb_agg(private.creative_asset_json(c) || jsonb_build_object('offerCode', b.offer_code,
      'brandKit', private.creative_brand_kit_json(k)) order by c.created_at), '[]'::jsonb) into v_claimed
  from claimed c join private.creative_briefs b on b.id = c.brief_id join private.brand_kits k on k.product = c.product;
  return jsonb_build_object('claimed', v_claimed, 'renderedToday', v_today + jsonb_array_length(v_claimed), 'cap', coalesce(p_daily_cap, 0));
end;
$$;

-- HeyGen renders still waiting for the provider, oldest first.
create function private.creative_render_jobs(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return coalesce((select jsonb_agg(private.creative_asset_json(a) || jsonb_build_object('renderJob', a.render_job, 'renderStartedAt', a.render_started_at,
      'brandKit', private.creative_brand_kit_json(k)) order by a.render_started_at)
    from (select * from private.creative_assets where status = 'rendering' and render_job is not null order by render_started_at limit least(greatest(coalesce(p_limit, 5), 1), 20)) a
    join private.brand_kits k on k.product = a.product), '[]'::jsonb);
end;
$$;

-- Records the provider's job for a render that finishes later.
create function private.creative_render_job(p_asset uuid, p_job jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  update private.creative_assets set render_job = p_job, updated_at = now() where id = p_asset and status = 'rendering';
  return found;
end;
$$;

-- Ends one render: `ready` (the file is stored and the asset passed the checks, with or without warnings), `blocked` (it failed a check:
-- no file is kept and the owner never sees it), `retry` (back to draft) or `failed` (with a code).
create function private.creative_render_finish(p_asset uuid, p_outcome text, p_file bytea, p_content_type text, p_compliance jsonb, p_meta jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_asset private.creative_assets%rowtype;
  v_code text := coalesce(p_meta ->> 'error', 'render_failed');
begin
  perform private.require_hub_app_server();
  select * into v_asset from private.creative_assets where id = p_asset for update;
  if not found then
    raise exception 'Unknown asset.' using errcode = 'P0002';
  end if;
  if v_asset.status <> 'rendering' then
    return jsonb_build_object('id', v_asset.id, 'status', v_asset.status, 'changed', false);
  end if;
  if p_outcome = 'ready' then
    if p_file is null or p_content_type not in ('image/png', 'video/mp4') or p_compliance ->> 'verdict' not in ('pass', 'warn') then
      raise exception 'A ready asset needs its file and a passing check.' using errcode = '22023';
    end if;
    insert into private.creative_files (product, kind, asset_id, content_type, bytes, sha256)
    values (v_asset.product, 'asset', v_asset.id, p_content_type, p_file, encode(sha256(p_file), 'hex'))
    on conflict (asset_id) where asset_id is not null do update set content_type = excluded.content_type, bytes = excluded.bytes, sha256 = excluded.sha256, created_at = now();
    update private.creative_assets set status = 'ready', compliance = p_compliance, content_type = p_content_type, file_bytes = octet_length(p_file),
      duration_seconds = coalesce((p_meta ->> 'durationSeconds')::numeric, duration_seconds), captions = coalesce(p_meta ->> 'captions', captions),
      alt_text = coalesce(p_meta ->> 'altText', alt_text), provider = coalesce(p_meta ->> 'provider', provider), render_job = null, render_error = null,
      rendered_at = now(), updated_at = now()
    where id = v_asset.id returning * into v_asset;
  elsif p_outcome = 'blocked' then
    if p_compliance ->> 'verdict' <> 'block' then
      raise exception 'A blocked asset needs the check that blocked it.' using errcode = '22023';
    end if;
    update private.creative_assets set status = 'blocked', compliance = p_compliance, render_job = null, rendered_at = now(), updated_at = now()
    where id = v_asset.id returning * into v_asset;
  elsif p_outcome = 'retry' then
    update private.creative_assets set status = case when render_attempts >= 3 then 'failed' else 'draft' end, render_job = null,
      render_error = case when v_code ~ '^[a-z][a-z_]{0,59}$' then v_code else 'render_failed' end, updated_at = now()
    where id = v_asset.id returning * into v_asset;
  elsif p_outcome = 'failed' then
    update private.creative_assets set status = 'failed', render_job = null,
      render_error = case when v_code ~ '^[a-z][a-z_]{0,59}$' then v_code else 'render_failed' end, updated_at = now()
    where id = v_asset.id returning * into v_asset;
  else
    raise exception 'Invalid render outcome.' using errcode = '22023';
  end if;
  return jsonb_build_object('id', v_asset.id, 'status', v_asset.status, 'changed', true);
end;
$$;

-- Rendered assets that passed the checks and are not yet proposed (the agent was observing, or proposing failed), oldest first.
create function private.creative_ready(p_limit integer, p_products text[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return coalesce((select jsonb_agg(private.creative_asset_json(a) order by a.rendered_at)
    from (select * from private.creative_assets where status = 'ready' and product = any(coalesce(p_products, array[]::text[]))
          order by rendered_at limit least(greatest(coalesce(p_limit, 10), 1), 50)) a), '[]'::jsonb);
end;
$$;

-- Links a ready asset to the action that proposes it.
create function private.creative_asset_proposed(p_asset uuid, p_action uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if not exists (select 1 from private.agent_actions where id = p_action and target_id = p_asset::text and kind in ('creative.asset', 'creative.asset_review')) then
    raise exception 'That action does not propose this asset.' using errcode = '55000';
  end if;
  update private.creative_assets set status = 'proposed', action_id = p_action, proposed_at = now(), updated_at = now()
  where id = p_asset and status = 'ready';
  return found;
end;
$$;

-- The owner's logo or a screenshot, for the renderer. Never an asset file.
create function private.creative_brand_file(p_id uuid) returns bytea
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return (select bytes from private.creative_files where id = p_id and kind in ('logo', 'screenshot'));
end;
$$;

-- Executor: an approved asset becomes `approved` and is handed to the Social Media Manager (it gets a public token so Meta and LinkedIn
-- can fetch it). Only the execution the database started for this action may hand it over. An asset approved automatically is handed over
-- only while the owner trusts the Creative Director with approvals and the asset passed every check with no warning.
create function private.creative_handoff(p_action uuid, p_execution integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_agent private.agents%rowtype;
  v_asset private.creative_assets%rowtype;
begin
  perform private.require_hub_app_server();
  select * into v_action from private.agent_actions where id = p_action for update;
  if not found or v_action.kind not in ('creative.asset', 'creative.asset_review') or v_action.status <> 'executing'
    or v_action.executions is distinct from p_execution then
    return jsonb_build_object('handedOver', false, 'reason', 'not_executing');
  end if;
  select * into v_asset from private.creative_assets where id = v_action.target_id::uuid and action_id = v_action.id for update;
  if not found then
    return jsonb_build_object('handedOver', false, 'reason', 'asset_missing');
  end if;
  if v_asset.status in ('approved', 'live') then
    return jsonb_build_object('handedOver', true, 'already', true, 'assetId', v_asset.id, 'status', v_asset.status);
  end if;
  if v_asset.status <> 'proposed' then
    return jsonb_build_object('handedOver', false, 'reason', 'asset_changed');
  end if;
  if v_action.decided_by is null then
    select * into v_agent from private.agents where key = 'creative_director' for share;
    if v_action.kind <> 'creative.asset' or v_asset.compliance ->> 'verdict' <> 'pass' or v_agent.status <> 'active' or v_agent.autonomy <> 'act'
      or not coalesce(v_agent.config -> 'auto_approve_kinds', '[]'::jsonb) ? 'creative.asset' then
      return jsonb_build_object('handedOver', false, 'reason', 'approval_required');
    end if;
  end if;
  update private.creative_assets set status = 'approved', approved_at = now(), public_token = private.creative_token(), updated_at = now()
  where id = v_asset.id returning * into v_asset;
  return jsonb_build_object('handedOver', true, 'already', false, 'assetId', v_asset.id, 'product', v_asset.product, 'platform', v_asset.platform,
    'placement', v_asset.placement, 'kind', v_asset.kind);
end;
$$;

-- Executor: a retirement the owner approved (or, once handed over, that the agent is trusted with) takes an asset out of use: no public
-- token, and the Social Media Manager stops using it.
create function private.creative_retire(p_action uuid, p_execution integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_agent private.agents%rowtype;
  v_asset private.creative_assets%rowtype;
begin
  perform private.require_hub_app_server();
  select * into v_action from private.agent_actions where id = p_action for update;
  if not found or v_action.kind <> 'creative.retire' or v_action.status <> 'executing' or v_action.executions is distinct from p_execution then
    return jsonb_build_object('retired', false, 'reason', 'not_executing');
  end if;
  if v_action.decided_by is null then
    select * into v_agent from private.agents where key = 'creative_director' for share;
    if v_agent.status <> 'active' or v_agent.autonomy <> 'act' or not coalesce(v_agent.config -> 'auto_approve_kinds', '[]'::jsonb) ? 'creative.retire' then
      return jsonb_build_object('retired', false, 'reason', 'approval_required');
    end if;
  end if;
  select * into v_asset from private.creative_assets where id = v_action.target_id::uuid for update;
  if not found then
    return jsonb_build_object('retired', false, 'reason', 'asset_missing');
  end if;
  if v_asset.status = 'retired' then
    return jsonb_build_object('retired', true, 'already', true, 'assetId', v_asset.id);
  end if;
  if v_asset.status not in ('approved', 'live') then
    return jsonb_build_object('retired', false, 'reason', 'asset_changed');
  end if;
  update private.creative_assets set status = 'retired', public_token = null, retired_at = now(), updated_at = now() where id = v_asset.id;
  return jsonb_build_object('retired', true, 'already', false, 'assetId', v_asset.id);
end;
$$;

-- For the Social Media Manager: approved creative not yet used, for a product and platform, oldest approval first. Ids, tokens and
-- CareMetric's own copy.
create function private.creative_approved(p_product text, p_platform text, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'token', a.public_token, 'product', a.product, 'platform', a.platform,
      'placement', a.placement, 'kind', a.kind, 'width', a.width, 'height', a.height, 'contentType', a.content_type, 'headline', a.headline,
      'primaryText', a.primary_text, 'description', a.description, 'cta', a.cta, 'landingUrl', a.landing_url, 'altText', a.alt_text,
      'hookType', a.hook_type) order by a.approved_at)
    from (select * from private.creative_assets where status = 'approved' and product = p_product and platform = p_platform
          order by approved_at limit least(greatest(coalesce(p_limit, 5), 1), 20)) a), '[]'::jsonb);
end;
$$;

-- An approved asset was published by the Social Media Manager (a post or an ad); `p_ref` is the platform's id for it.
create function private.creative_mark_live(p_asset uuid, p_ref text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  update private.creative_assets set status = 'live', live_at = coalesce(live_at, now()), live_ref = coalesce(live_ref, left(p_ref, 200)), updated_at = now()
  where id = p_asset and status in ('approved', 'live');
  return found;
end;
$$;

-- The file behind a public token, only while its asset is approved or live.
create function private.creative_public_file(p_token text) returns table (content_type text, bytes bytea)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  return query select f.content_type, f.bytes from private.creative_assets a join private.creative_files f on f.asset_id = a.id
    where a.public_token = p_token and a.status in ('approved', 'live');
end;
$$;

-- Approved and live creative with what is known about how it did, for the weekly refresh and report.
create function private.creative_live_assets(p_products text[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'briefId', a.brief_id, 'product', a.product, 'platform', a.platform, 'placement', a.placement,
      'kind', a.kind, 'layout', a.layout, 'hookType', a.hook_type, 'lengthKey', a.length_key, 'status', a.status, 'headline', a.headline,
      'variantLabel', a.variant_label, 'approvedAt', a.approved_at, 'liveAt', a.live_at, 'liveRef', a.live_ref, 'performance', a.performance) order by a.approved_at)
    from private.creative_assets a where a.status in ('approved', 'live') and a.product = any(coalesce(p_products, array['carebase', 'caremetric-intel']))), '[]'::jsonb);
end;
$$;

-- The week's results per asset: [{ id, performance }].
create function private.creative_performance_save(p_rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform private.require_hub_app_server();
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Invalid results.' using errcode = '22023';
  end if;
  update private.creative_assets a set performance = r.value -> 'performance', updated_at = now()
  from jsonb_array_elements(p_rows) r
  where a.id = (r.value ->> 'id')::uuid and jsonb_typeof(r.value -> 'performance') = 'object';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The learnings the weekly report found, one verdict per pattern (the latest evidence replaces the last).
create function private.creative_learnings_save(p_rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform private.require_hub_app_server();
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 200 then
    raise exception 'Invalid learnings.' using errcode = '22023';
  end if;
  insert into private.creative_learnings (product, platform, pattern_kind, pattern_value, verdict, samples, score, evidence, observed_at)
  select r ->> 'product', r ->> 'platform', r ->> 'kind', r ->> 'value', r ->> 'verdict', (r ->> 'samples')::integer, (r ->> 'score')::numeric,
    coalesce(r -> 'evidence', '{}'::jsonb), now()
  from jsonb_array_elements(p_rows) r
  on conflict (product, platform, pattern_kind, pattern_value) do update set verdict = excluded.verdict, samples = excluded.samples, score = excluded.score,
    evidence = excluded.evidence, observed_at = excluded.observed_at;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Website leads (never test leads) whose utm_content names one of the assets, between two times: [{ assetId, leads, trials }]. Counts only.
create function private.creative_leads(p_since timestamptz, p_until timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return coalesce((select jsonb_agg(jsonb_build_object('assetId', a.id, 'leads', x.leads, 'trials', x.trials))
    from (select lower(l.utm_content) as content, count(*) as leads, count(*) filter (where l.kind = 'trial_signup') as trials
          from private.leads l
          where not l.test and l.created_at >= p_since and l.created_at < p_until
            and l.utm_content ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          group by lower(l.utm_content)) x
    join private.creative_assets a on a.id = x.content::uuid), '[]'::jsonb);
end;
$$;

-- Assets with an open creative action ("kind:asset id"), so the same asset is never proposed twice while the owner has not decided.
create function private.creative_open_targets() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return (select coalesce(jsonb_agg(distinct a.kind || ':' || a.target_id), '[]'::jsonb) from private.agent_actions a
          where a.agent_key = 'creative_director' and a.kind like 'creative.%' and a.status in ('proposed', 'approved', 'auto_approved', 'executing')
            and a.created_at > now() - interval '14 days');
end;
$$;

-- Counts for the Chief of Staff's morning brief: what waits for the owner, what was approved and published this week, what was blocked,
-- renders today, and the strongest learning per product. No copy.
create function private.creative_brief_facts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return jsonb_build_object(
    'waiting', (select count(*) from private.creative_assets where status = 'proposed'),
    'inProduction', (select count(*) from private.creative_assets where status in ('draft', 'rendering', 'ready')),
    'approvedWeek', (select count(*) from private.creative_assets where approved_at > now() - interval '7 days'),
    'liveWeek', (select count(*) from private.creative_assets where live_at > now() - interval '7 days'),
    'blockedWeek', (select count(*) from private.creative_assets where status = 'blocked' and updated_at > now() - interval '7 days'),
    'renderedToday', (select count(*) from private.creative_assets where render_started_at >= private.creative_today_start()),
    'learnings', coalesce((select jsonb_agg(jsonb_build_object('product', l.product, 'platform', l.platform, 'kind', l.pattern_kind, 'value', l.pattern_value,
        'verdict', l.verdict, 'samples', l.samples))
      from (select distinct on (product) * from private.creative_learnings where verdict = 'win' order by product, score desc, samples desc) l), '[]'::jsonb));
end;
$$;

revoke all on function private.creative_plan_inputs(integer), private.creative_brief_create(jsonb), private.creative_brief_context(uuid),
  private.creative_brief_finish(uuid, text, jsonb), private.creative_drafts_save(uuid, uuid, jsonb), private.creative_render_claim(integer, integer, text[]),
  private.creative_render_jobs(integer), private.creative_render_job(uuid, jsonb), private.creative_render_finish(uuid, text, bytea, text, jsonb, jsonb),
  private.creative_ready(integer, text[]), private.creative_asset_proposed(uuid, uuid), private.creative_brand_file(uuid), private.creative_handoff(uuid, integer),
  private.creative_retire(uuid, integer), private.creative_approved(text, text, integer), private.creative_mark_live(uuid, text), private.creative_public_file(text),
  private.creative_live_assets(text[]), private.creative_performance_save(jsonb), private.creative_learnings_save(jsonb), private.creative_leads(timestamptz, timestamptz),
  private.creative_open_targets(), private.creative_brief_facts()
  from public, anon, authenticated, service_role;
grant execute on function private.creative_plan_inputs(integer), private.creative_brief_create(jsonb), private.creative_brief_context(uuid),
  private.creative_brief_finish(uuid, text, jsonb), private.creative_drafts_save(uuid, uuid, jsonb), private.creative_render_claim(integer, integer, text[]),
  private.creative_render_jobs(integer), private.creative_render_job(uuid, jsonb), private.creative_render_finish(uuid, text, bytea, text, jsonb, jsonb),
  private.creative_ready(integer, text[]), private.creative_asset_proposed(uuid, uuid), private.creative_brand_file(uuid), private.creative_handoff(uuid, integer),
  private.creative_retire(uuid, integer), private.creative_approved(text, text, integer), private.creative_mark_live(uuid, text), private.creative_public_file(text),
  private.creative_live_assets(text[]), private.creative_performance_save(jsonb), private.creative_learnings_save(jsonb), private.creative_leads(timestamptz, timestamptz),
  private.creative_open_targets(), private.creative_brief_facts()
  to hub_app_server;

-- ---- Owner operations -----------------------------------------------------------------------------------------------------------------

-- The Creative screen: the gallery (filtered by product, platform and status; blocked assets are never listed, only counted), the
-- recent briefs, both brand kits, and the learnings.
create function hub.get_creative_studio(p_filter jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_product text := nullif(p_filter ->> 'product', '');
  v_platform text := nullif(p_filter ->> 'platform', '');
  v_status text := nullif(p_filter ->> 'status', '');
  v_offset integer := least(greatest(coalesce((p_filter ->> 'offset')::integer, 0), 0), 10000);
  v_limit integer := least(greatest(coalesce((p_filter ->> 'limit')::integer, 24), 1), 60);
begin
  perform hub.authorize_app_admin();
  if v_status = 'blocked' then
    raise exception 'Blocked creative is never shown.' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'assets', coalesce((select jsonb_agg(private.creative_asset_json(a) || jsonb_build_object('actionStatus', x.status) order by a.created_at desc, a.id)
      from (select * from private.creative_assets
            where status <> 'blocked' and (v_product is null or product = v_product) and (v_platform is null or platform = v_platform)
              and (v_status is null or status = v_status)
            order by created_at desc, id offset v_offset limit v_limit) a
      left join private.agent_actions x on x.id = a.action_id), '[]'::jsonb),
    'total', (select count(*) from private.creative_assets where status <> 'blocked' and (v_product is null or product = v_product)
      and (v_platform is null or platform = v_platform) and (v_status is null or status = v_status)),
    'statusCounts', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from private.creative_assets where status <> 'blocked' group by status) s), '{}'::jsonb),
    'blocked', (select count(*) from private.creative_assets where status = 'blocked'),
    'briefs', coalesce((select jsonb_agg(private.creative_brief_json(b) order by b.created_at desc) from (select * from private.creative_briefs order by created_at desc limit 20) b), '[]'::jsonb),
    'brandKits', coalesce((select jsonb_agg(private.creative_brand_kit_json(k) order by k.product) from private.brand_kits k), '[]'::jsonb),
    'learnings', coalesce((select jsonb_agg(jsonb_build_object('product', l.product, 'platform', l.platform, 'kind', l.pattern_kind, 'value', l.pattern_value,
        'verdict', l.verdict, 'samples', l.samples, 'score', l.score, 'observedAt', l.observed_at) order by l.observed_at desc)
      from (select * from private.creative_learnings order by observed_at desc limit 30) l), '[]'::jsonb));
end;
$$;

-- One file for the owner to preview or download: an asset's (never a blocked one) or a brand file.
create function hub.get_creative_file(p_id uuid) returns table (content_type text, bytes bytea, file_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform hub.authorize_app_admin();
  return query
    select f.content_type, f.bytes,
      case when f.kind = 'asset' then 'caremetric-' || a.product || '-' || a.placement || '-' || left(a.id::text, 8) || case when f.content_type = 'video/mp4' then '.mp4' else '.png' end
           else 'caremetric-' || f.product || '-' || f.kind || case when f.content_type = 'image/jpeg' then '.jpg' else '.png' end end
    from private.creative_files f left join private.creative_assets a on a.id = f.asset_id
    where (f.asset_id = p_id and a.status <> 'blocked') or (f.id = p_id and f.kind in ('logo', 'screenshot'));
end;
$$;

-- The owner edits a brand kit. Only the listed fields change; a stale screen is refused; every change is audited.
create function hub.set_brand_kit(p_product text, p_kit jsonb, p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_kit private.brand_kits%rowtype;
  v_key text;
  v_list text[];
begin
  v_actor := hub.authorize_app_command();
  if jsonb_typeof(p_kit) <> 'object' then
    raise exception 'Invalid brand kit.' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_kit) loop
    if v_key not in ('primaryColor', 'secondaryColor', 'accentColor', 'textColor', 'backgroundColor', 'headingFont', 'bodyFont', 'voiceNotes',
      'requiredDisclaimers', 'bannedPhrases', 'videoAvatarId', 'videoVoiceId', 'captionsDefault') then
      raise exception 'Invalid brand kit field.' using errcode = '22023';
    end if;
  end loop;
  foreach v_key in array array['requiredDisclaimers', 'bannedPhrases'] loop
    if p_kit ? v_key then
      if jsonb_typeof(p_kit -> v_key) <> 'array' then
        raise exception 'Invalid brand kit list.' using errcode = '22023';
      end if;
      v_list := array(select btrim(value) from jsonb_array_elements_text(p_kit -> v_key) where btrim(value) <> '');
      if exists (select 1 from unnest(v_list) item where char_length(item) > 200 or item ~ '[[:cntrl:]]') then
        raise exception 'Each phrase or disclaimer must be one line of at most 200 characters.' using errcode = '22023';
      end if;
    end if;
  end loop;
  select * into v_kit from private.brand_kits where product = p_product for update;
  if not found then
    raise exception 'Unknown product.' using errcode = 'P0002';
  end if;
  if v_kit.version is distinct from p_expected_version then
    raise exception 'This brand kit changed. Refresh and review again.' using errcode = '40001';
  end if;
  update private.brand_kits set
    primary_color = case when p_kit ? 'primaryColor' then nullif(p_kit ->> 'primaryColor', '') else primary_color end,
    secondary_color = case when p_kit ? 'secondaryColor' then nullif(p_kit ->> 'secondaryColor', '') else secondary_color end,
    accent_color = case when p_kit ? 'accentColor' then nullif(p_kit ->> 'accentColor', '') else accent_color end,
    text_color = case when p_kit ? 'textColor' then nullif(p_kit ->> 'textColor', '') else text_color end,
    background_color = case when p_kit ? 'backgroundColor' then nullif(p_kit ->> 'backgroundColor', '') else background_color end,
    heading_font = case when p_kit ? 'headingFont' then nullif(p_kit ->> 'headingFont', '') else heading_font end,
    body_font = case when p_kit ? 'bodyFont' then nullif(p_kit ->> 'bodyFont', '') else body_font end,
    voice_notes = case when p_kit ? 'voiceNotes' then coalesce(p_kit ->> 'voiceNotes', '') else voice_notes end,
    required_disclaimers = case when p_kit ? 'requiredDisclaimers' then array(select btrim(value) from jsonb_array_elements_text(p_kit -> 'requiredDisclaimers') where btrim(value) <> '') else required_disclaimers end,
    banned_phrases = case when p_kit ? 'bannedPhrases' then array(select btrim(value) from jsonb_array_elements_text(p_kit -> 'bannedPhrases') where btrim(value) <> '') else banned_phrases end,
    video_avatar_id = case when p_kit ? 'videoAvatarId' then nullif(p_kit ->> 'videoAvatarId', '') else video_avatar_id end,
    video_voice_id = case when p_kit ? 'videoVoiceId' then nullif(p_kit ->> 'videoVoiceId', '') else video_voice_id end,
    captions_default = case when p_kit ? 'captionsDefault' then coalesce((p_kit ->> 'captionsDefault')::boolean, true) else captions_default end,
    version = version + 1, updated_at = now(), updated_by = (v_actor ->> 'user_id')::uuid
  where product = p_product returning * into v_kit;
  insert into private.audit_events (actor_id, action, entity_type, metadata)
  values ((v_actor ->> 'user_id')::uuid, 'creative.brand_kit', 'agent', jsonb_build_object('product', p_product, 'fields',
    (select jsonb_agg(k order by k) from jsonb_object_keys(p_kit) k), 'version', v_kit.version));
  return private.creative_brand_kit_json(v_kit);
end;
$$;

-- The owner adds the product's logo (it replaces the last one) or a screenshot. A screenshot needs the owner's attestation that it shows no
-- patient, resident or personal information.
create function hub.add_brand_file(p_product text, p_kind text, p_content_type text, p_bytes bytea, p_label text, p_attested boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_id uuid;
  v_kit private.brand_kits%rowtype;
  v_limit integer := case when p_kind = 'logo' then 1048576 else 5242880 end;
begin
  v_actor := hub.authorize_app_command();
  if p_kind not in ('logo', 'screenshot') or p_content_type not in ('image/png', 'image/jpeg') or p_bytes is null
    or octet_length(p_bytes) > v_limit or char_length(coalesce(p_label, '')) > 120 then
    raise exception 'A logo must be a PNG or JPEG of at most 1 MB, and a screenshot at most 5 MB.' using errcode = '22023';
  end if;
  if p_kind = 'screenshot' and p_attested is not true then
    raise exception 'Confirm that the screenshot shows no patient, resident or personal information.' using errcode = '22023';
  end if;
  if p_kind = 'screenshot' and (select count(*) from private.creative_files where product = p_product and kind = 'screenshot') >= 12 then
    raise exception 'A product keeps at most 12 screenshots. Remove one first.' using errcode = '22023';
  end if;
  select * into v_kit from private.brand_kits where product = p_product for update;
  if not found then
    raise exception 'Unknown product.' using errcode = 'P0002';
  end if;
  insert into private.creative_files (product, kind, content_type, bytes, sha256, label, phi_free_attested, created_by)
  values (p_product, p_kind, p_content_type, p_bytes, encode(sha256(p_bytes), 'hex'), coalesce(btrim(p_label), ''), coalesce(p_attested, false),
    (v_actor ->> 'user_id')::uuid)
  returning id into v_id;
  if p_kind = 'logo' then
    delete from private.creative_files where product = p_product and kind = 'logo' and id <> v_id;
    update private.brand_kits set logo_file_id = v_id, version = version + 1, updated_at = now(), updated_by = (v_actor ->> 'user_id')::uuid where product = p_product;
  else
    update private.brand_kits set version = version + 1, updated_at = now(), updated_by = (v_actor ->> 'user_id')::uuid where product = p_product;
  end if;
  insert into private.audit_events (actor_id, action, entity_type, metadata)
  values ((v_actor ->> 'user_id')::uuid, 'creative.brand_file', 'agent', jsonb_build_object('product', p_product, 'kind', p_kind, 'bytes', octet_length(p_bytes),
    'attested', coalesce(p_attested, false)));
  select * into v_kit from private.brand_kits where product = p_product;
  return private.creative_brand_kit_json(v_kit);
end;
$$;

-- The owner removes a screenshot or the logo.
create function hub.remove_brand_file(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_file private.creative_files%rowtype;
  v_kit private.brand_kits%rowtype;
begin
  v_actor := hub.authorize_app_command();
  delete from private.creative_files where id = p_id and kind in ('logo', 'screenshot') returning * into v_file;
  if not found then
    raise exception 'Unknown file.' using errcode = 'P0002';
  end if;
  update private.brand_kits set version = version + 1, updated_at = now(), updated_by = (v_actor ->> 'user_id')::uuid where product = v_file.product
  returning * into v_kit;
  insert into private.audit_events (actor_id, action, entity_type, metadata)
  values ((v_actor ->> 'user_id')::uuid, 'creative.brand_file_removed', 'agent', jsonb_build_object('product', v_file.product, 'kind', v_file.kind));
  return private.creative_brand_kit_json(v_kit);
end;
$$;

-- The owner's own brief from the New brief form. It must be for a product the team markets; a repeated press of the same form is one
-- brief. It queues the drafting task straight away.
create function hub.create_creative_brief(p_brief jsonb, p_request_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_brief private.creative_briefs%rowtype;
  v_created boolean := true;
begin
  v_actor := hub.authorize_app_command();
  if jsonb_typeof(p_brief) <> 'object' or p_request_key is null then
    raise exception 'Invalid brief.' using errcode = '22023';
  end if;
  if not exists (select 1 from private.marketing_products m where m.product = p_brief ->> 'product' and m.marketed) then
    raise exception 'The team does not market this product right now. Switch it on under Products we market on the AI team page first.' using errcode = '22023';
  end if;
  insert into private.creative_briefs (product, goal, audience, offer_code, platforms, formats, video_lengths, angle, source, request_key, created_by)
  values (p_brief ->> 'product', btrim(p_brief ->> 'goal'), btrim(p_brief ->> 'audience'), nullif(btrim(coalesce(p_brief ->> 'offerCode', '')), ''),
    array(select jsonb_array_elements_text(coalesce(p_brief -> 'platforms', '[]'))),
    coalesce(nullif(array(select jsonb_array_elements_text(coalesce(p_brief -> 'formats', '[]'))), array[]::text[]), array['static']),
    array(select jsonb_array_elements_text(coalesce(p_brief -> 'videoLengths', '[]'))),
    btrim(coalesce(p_brief ->> 'angle', '')), 'owner', 'owner:' || p_request_key::text, (v_actor ->> 'user_id')::uuid)
  on conflict (request_key) do nothing
  returning * into v_brief;
  if v_brief.id is null then
    v_created := false;
    select * into v_brief from private.creative_briefs where request_key = 'owner:' || p_request_key::text;
  else
    insert into private.agent_tasks (agent_key, kind, request_key, payload, priority, due_at, source_kind, source_ref, status)
    values ('creative_director', 'creative.request', 'creative:brief:' || v_brief.id::text, jsonb_build_object('briefId', v_brief.id), 3, now(), 'owner', 'brief', 'queued')
    on conflict (request_key) do nothing;
    insert into private.audit_events (actor_id, action, entity_type, metadata)
    values ((v_actor ->> 'user_id')::uuid, 'creative.brief', 'agent', jsonb_build_object('product', v_brief.product, 'platforms', to_jsonb(v_brief.platforms),
      'formats', to_jsonb(v_brief.formats)));
  end if;
  return private.creative_brief_json(v_brief) || jsonb_build_object('created', v_created);
end;
$$;

revoke all on function hub.get_creative_studio(jsonb), hub.get_creative_file(uuid), hub.set_brand_kit(text, jsonb, integer),
  hub.add_brand_file(text, text, text, bytea, text, boolean), hub.remove_brand_file(uuid), hub.create_creative_brief(jsonb, uuid)
  from public, anon, service_role;
grant execute on function hub.get_creative_studio(jsonb), hub.get_creative_file(uuid), hub.set_brand_kit(text, jsonb, integer),
  hub.add_brand_file(text, text, text, bytea, text, boolean), hub.remove_brand_file(uuid), hub.create_creative_brief(jsonb, uuid)
  to authenticated;

-- Settings → Creative (server/hub-settings.mjs): the switch, the daily render cap and how videos are made. They were never Railway
-- variables; HeyGen's key, a secret, is the one variable (HUB_HEYGEN_API_KEY).
insert into private.hub_settings (key, kind) values
  ('creative.enabled', 'flag'),
  ('creative.daily_render_cap', 'number'),
  ('creative.video_provider', 'text')
on conflict (key) do nothing;
