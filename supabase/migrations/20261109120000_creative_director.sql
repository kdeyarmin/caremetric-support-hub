-- The Creative Director: data model only. A new member of the AI team that turns the marketing plans into finished, on-brand,
-- compliant ad creative for the owner's approval. This migration creates the four tables it works from, a private storage bucket for
-- the finished files and the agent row itself, seeded paused. It adds no function, schedule, autonomy step, feature declaration or
-- action kind: the operations that reach these tables, and everything that behaves, arrive in later changes.
--
-- Boundary (the same closed shape as the AI team control plane in 20261102120000): every table has row level security and NO
-- privilege for any browser, service or server role, and no policy. The Hub server will reach them only through security definer
-- operations added later.

-- One row per product. The brand name is always "CareMetric". Every other field starts blank on purpose.
create table private.brand_kits (
  product text primary key check (product in ('carebase', 'caremetric-intel')),
  brand_name text not null default 'CareMetric' check (brand_name = 'CareMetric'),
  logo_path text,
  primary_color text check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_color text check (secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color text check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  text_color text check (text_color ~ '^#[0-9A-Fa-f]{6}$'),
  background_color text check (background_color ~ '^#[0-9A-Fa-f]{6}$'),
  heading_font text,
  body_font text,
  voice_notes text not null default '',
  required_disclaimers text[] not null default '{}',
  banned_phrases text[] not null default '{}',
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

-- What to make, for whom and where. An audience describes a business, never a person's health, so it may not contain any of the
-- health-attribute words below (whole words, any case, singular or plural): diagnosis, condition, disease, medication, patient,
-- symptom, disability, pregnancy, cancer, diabetes, depression, HIV. An offer is named by its code, never by a price.
create table private.creative_briefs (
  id uuid primary key default gen_random_uuid(),
  product text not null check (product in ('carebase', 'caremetric-intel')),
  goal text not null check (char_length(goal) between 1 and 500),
  audience text not null check (
    char_length(audience) between 1 and 500
    and audience !~* '\y(diagnos[ei]s|conditions?|diseases?|medications?|patients?|symptoms?|disabilit(y|ies)|pregnanc(y|ies)|cancers?|diabetes|depression|hiv)\y'),
  offer_code text,
  platforms text[] not null check (
    cardinality(platforms) between 1 and 10
    and platforms <@ array['meta', 'linkedin', 'google', 'youtube']),
  angle text not null default '',
  source text not null check (source in ('social.plan', 'growth.plan', 'owner', 'refresh')),
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  plan_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index creative_briefs_product_status on private.creative_briefs (product, status);

-- One row per finished piece of creative. A landing address, when there is one, carries utm_content= so a result can be traced to
-- the asset; the asset id itself is filled in by the server later.
create table private.creative_assets (
  id uuid primary key default gen_random_uuid(),
  brief_id uuid not null references private.creative_briefs(id) on delete restrict,
  product text not null check (product in ('carebase', 'caremetric-intel')),
  platform text not null check (platform in ('meta', 'linkedin', 'google', 'youtube')),
  format text not null check (char_length(format) between 1 and 40),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  variant_label text not null check (char_length(variant_label) between 1 and 40),
  hook_type text not null check (hook_type in ('problem', 'proof', 'offer', 'curiosity', 'demo')),
  headline text not null default '',
  primary_text text not null default '',
  cta text not null default '',
  landing_url text check (landing_url is null or position('utm_content=' in landing_url) > 0),
  alt_text text not null default '',
  captions text not null default '',
  storage_path text,
  status text not null default 'draft' check (status in ('draft', 'proposed', 'approved', 'rejected', 'live', 'retired')),
  compliance jsonb not null default '{}' check (jsonb_typeof(compliance) = 'object'),
  performance jsonb not null default '{}' check (jsonb_typeof(performance) = 'object'),
  revision_notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index creative_assets_brief on private.creative_assets (brief_id);
create index creative_assets_product_platform_status on private.creative_assets (product, platform, status);

-- What worked and what did not, one verdict per pattern, so the next brief starts from evidence.
create table private.creative_learnings (
  id uuid primary key default gen_random_uuid(),
  product text not null check (product in ('carebase', 'caremetric-intel')),
  platform text not null check (platform in ('meta', 'linkedin', 'google', 'youtube')),
  pattern_kind text not null check (pattern_kind in ('hook', 'format', 'length', 'layout', 'color')),
  pattern_value text not null check (char_length(pattern_value) between 1 and 120),
  verdict text not null check (verdict in ('win', 'lose')),
  evidence jsonb not null default '{}' check (jsonb_typeof(evidence) = 'object'),
  observed_at timestamptz not null default now(),
  unique (product, platform, pattern_kind, pattern_value, verdict)
);

alter table private.brand_kits enable row level security;
alter table private.creative_briefs enable row level security;
alter table private.creative_assets enable row level security;
alter table private.creative_learnings enable row level security;
revoke all on private.brand_kits, private.creative_briefs, private.creative_assets, private.creative_learnings
  from public, anon, authenticated, service_role, hub_app_server;

-- The two brand kits start BLANK: only the defaults above. The owner fills in the logo, colors, fonts and voice later; none of
-- them is written here.
insert into private.brand_kits (product) values ('carebase'), ('caremetric-intel');

-- Finished creative files. Private: nothing is public, and no storage policy is added here.
insert into storage.buckets (id, name, public) values ('creative', 'creative', false)
on conflict (id) do nothing;

-- The Creative Director, paused, in Propose. Nothing is published until the owner approves it.
insert into private.agents (key, display_name, role_summary, status, autonomy, model_tier, daily_budget_cents, tool_allowlist, config)
values ('creative_director', 'Creative Director',
  'Turns marketing plans into finished, on-brand, compliant ad creative for your approval. Nothing is published until you approve it.',
  'paused', 'propose', 'quality', 300,
  array['creative_brief', 'creative_render_static', 'creative_render_video', 'creative_compliance_check', 'propose_creative', 'creative_report', 'notify_owner'],
  '{"auto_approve_kinds": [], "effort": "medium"}'::jsonb)
on conflict (key) do nothing;
