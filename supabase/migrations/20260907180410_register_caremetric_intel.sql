insert into hub.products (
  id,
  slug,
  name,
  description,
  status,
  color,
  support_enabled
)
values (
  '00000000-0000-4000-8000-000000000006',
  'caremetric-intel',
  'CareMetric Intel',
  'Healthcare provider intelligence, CRM, and analytics for post-acute organizations.',
  'pilot',
  '#0891b2',
  true
)
on conflict (slug) do update
set
  name = excluded.name,
  description = excluded.description,
  status = excluded.status,
  color = excluded.color,
  support_enabled = excluded.support_enabled;

-- Reuse only the governed CareBase course catalog and the two explicitly
-- reviewed Support Hub core articles. CareMetric Intel's product-specific
-- guide remains in its source application until its own manifest is reviewed.
insert into hub.content_publications (
  item_id,
  revision_id,
  product_id,
  audience,
  route_pattern,
  published_at
)
select
  publication.item_id,
  publication.revision_id,
  caremetric_intel.id,
  publication.audience,
  case when item.kind = 'course' then null else publication.route_pattern end,
  publication.published_at
from hub.content_publications publication
join hub.products carebase
  on carebase.id = publication.product_id
 and carebase.slug = 'carebase'
join hub.products caremetric_intel
  on caremetric_intel.slug = 'caremetric-intel'
join hub.content_items item
  on item.id = publication.item_id
where (
    item.kind = 'course'
    and item.status = 'published'
    and item.source_system = 'penntrain'
    and item.retired_at is null
  )
  or item.content_key in (
    'account.invite-user',
    'support.protect-patient-information'
  )
on conflict (item_id, product_id) do update
set
  revision_id = excluded.revision_id,
  audience = excluded.audience,
  route_pattern = excluded.route_pattern,
  published_at = excluded.published_at,
  expires_at = null
where excluded.published_at >= hub.content_publications.published_at;
