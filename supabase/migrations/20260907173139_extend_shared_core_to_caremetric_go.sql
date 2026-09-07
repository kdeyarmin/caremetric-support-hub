-- Extend only the two explicitly reviewed Support Hub core articles to the
-- newly registered CareMetric Go product. Product-specific source articles
-- remain scoped to their originating products.
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
  publication.route_pattern,
  publication.published_at
from hub.content_publications publication
join hub.products carebase
  on carebase.id = publication.product_id
 and carebase.slug = 'carebase'
join hub.products caremetric_go
  on caremetric_go.slug = 'caremetric-go'
join hub.content_items item
  on item.id = publication.item_id
where item.content_key in (
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
