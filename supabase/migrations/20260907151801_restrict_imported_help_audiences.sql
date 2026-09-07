-- PennTrain role names do not map one-to-one to Support Hub memberships.
-- Keep unrestricted source articles available to entitled CareBase members,
-- and fail closed for every source-role-restricted article until federated
-- source-role claims have an explicit reviewed mapping. Content staff retain
-- access through content.read/content.write permission checks.

update hub.content_publications publication
set audience = case
  when jsonb_typeof(revision.variables -> 'source_audience') = 'array'
    and jsonb_array_length(revision.variables -> 'source_audience') = 0
    then array['all']::text[]
  else array['staff-review']::text[]
end
from hub.content_items item
join hub.content_revisions revision
  on revision.item_id = item.id
where publication.item_id = item.id
  and publication.revision_id = revision.id
  and item.content_key like 'penntrain.help.%';
