-- Keep the approved customer-only onboarding course aligned across the six
-- registered products. This copies publication metadata only; no learner,
-- quiz, certificate, tenant, patient, media, or provider-job data is copied.
insert into hub.content_publications (
  item_id,
  revision_id,
  product_id,
  audience,
  route_pattern,
  published_at
)
select
  source_publication.item_id,
  source_publication.revision_id,
  target.id,
  source_publication.audience,
  null,
  source_publication.published_at
from hub.content_publications source_publication
join hub.products source_product
  on source_product.id = source_publication.product_id
 and source_product.slug = 'carebase'
join hub.content_items item
  on item.id = source_publication.item_id
 and item.content_key = 'course.team-onboarding'
join hub.products target
  on target.slug in (
    'carebase',
    'breathe',
    'pennsync',
    'caremetric-emr',
    'caremetric-go',
    'caremetric-intel'
  )
where item.kind = 'course'
  and item.status = 'published'
  and item.retired_at is null
on conflict (item_id, product_id) do update
set
  revision_id = excluded.revision_id,
  audience = excluded.audience,
  route_pattern = excluded.route_pattern,
  published_at = excluded.published_at,
  expires_at = null
where excluded.published_at >= hub.content_publications.published_at;
