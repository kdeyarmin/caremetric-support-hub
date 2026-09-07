revoke select
on table
  hub.content_items,
  hub.content_revisions,
  hub.content_publications,
  hub.content_relations,
  hub.media_assets,
  hub.course_links,
  hub.published_content
from anon, authenticated;
