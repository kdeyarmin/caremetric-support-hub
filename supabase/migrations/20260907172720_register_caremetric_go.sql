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
  '00000000-0000-4000-8000-000000000005',
  'caremetric-go',
  'CareMetric Go',
  'Secure companion clinical app and patient portal for CareMetric AI.',
  'pilot',
  '#2563eb',
  true
)
on conflict (slug) do update
set
  name = excluded.name,
  description = excluded.description,
  status = excluded.status,
  color = excluded.color,
  support_enabled = excluded.support_enabled;

-- Reuse the already-approved CareBase course revision for the companion app.
-- This copies governed catalog placement only: it does not copy learner data,
-- private media locators, HeyGen jobs, progress, quizzes, or certificates.
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
  caremetric_go.id,
  publication.audience,
  null,
  publication.published_at
from hub.content_publications publication
join hub.products carebase
  on carebase.id = publication.product_id
 and carebase.slug = 'carebase'
join hub.products caremetric_go
  on caremetric_go.slug = 'caremetric-go'
join hub.content_items item
  on item.id = publication.item_id
where item.kind = 'course'
  and item.status = 'published'
  and item.source_system = 'penntrain'
  and item.retired_at is null
on conflict (item_id, product_id) do update
set
  revision_id = excluded.revision_id,
  audience = excluded.audience,
  route_pattern = excluded.route_pattern,
  published_at = excluded.published_at,
  expires_at = null
where excluded.published_at >= hub.content_publications.published_at;
