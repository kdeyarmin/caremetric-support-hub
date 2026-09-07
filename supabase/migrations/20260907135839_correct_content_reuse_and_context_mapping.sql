create or replace function private.can_access_content_publication(
  p_item_id uuid,
  p_revision_id uuid,
  p_product_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from hub.content_publications publication
    join hub.content_items item
      on item.id = publication.item_id
    join hub.content_revisions revision
      on revision.id = publication.revision_id
     and revision.item_id = publication.item_id
    join hub.products publication_product
      on publication_product.id = publication.product_id
    where publication.item_id = p_item_id
      and publication.revision_id = p_revision_id
      and publication.product_id = p_product_id
      and (revision.product_overlay_id is null or revision.product_overlay_id = publication.product_id)
      and (
        private.has_staff_permission('content.read', publication.product_id)
        or private.has_staff_permission('content.write', publication.product_id)
        or (
          item.status = 'published'
          and revision.review_state = 'approved'
          and publication_product.status <> 'retired'
          and publication_product.support_enabled
          and publication.published_at <= now()
          and (publication.expires_at is null or publication.expires_at > now())
          and (
            (
              item.access_level = 'public'
              and 'all' = any(coalesce(publication.audience, array[]::text[]))
            )
            or (
              item.access_level = 'customer'
              and private.has_active_content_audience(publication.product_id, publication.audience)
            )
          )
        )
      )
  );
$$;

create or replace function private.can_view_media_asset(p_asset_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from hub.media_assets media
    join hub.content_items item on item.id = media.content_item_id
    join hub.content_revisions revision
      on revision.id = media.revision_id
     and revision.item_id = media.content_item_id
    where media.id = p_asset_id
      and (
        revision.product_overlay_id is null
        or media.product_id is null
        or media.product_id = revision.product_overlay_id
      )
      and (
        private.has_staff_permission(
          'content.read',
          coalesce(media.product_id, revision.product_overlay_id, item.owner_product_id)
        )
        or private.has_staff_permission(
          'content.write',
          coalesce(media.product_id, revision.product_overlay_id, item.owner_product_id)
        )
        or exists (
          select 1
          from hub.content_publications publication
          where publication.item_id = media.content_item_id
            and publication.revision_id = media.revision_id
            and (media.product_id is null or media.product_id = publication.product_id)
            and private.can_access_content_publication(
              publication.item_id,
              publication.revision_id,
              publication.product_id
            )
            and (
              private.has_staff_permission('content.read', publication.product_id)
              or private.has_staff_permission('content.write', publication.product_id)
              or (
                media.render_status = 'ready'
                and media.data_classification = 'none'
                and (
                  (media.access_level = 'public' and item.access_level = 'public')
                  or (
                    media.access_level = 'customer'
                    and item.access_level = 'customer'
                    and private.has_active_content_audience(
                      publication.product_id,
                      publication.audience
                    )
                  )
                )
              )
            )
        )
      )
  );
$$;

revoke all on function private.can_access_content_publication(uuid, uuid, uuid)
from public, anon, authenticated;
revoke all on function private.can_view_media_asset(uuid)
from public, anon, authenticated;
grant execute on function private.can_access_content_publication(uuid, uuid, uuid)
to anon, authenticated;
grant execute on function private.can_view_media_asset(uuid)
to anon, authenticated;

drop function if exists hub.list_published_content();

create function hub.list_published_content()
returns table (
  id uuid,
  content_key text,
  kind hub.content_kind,
  title text,
  summary text,
  body_markdown text,
  status hub.content_status,
  access_level hub.access_level,
  product_ids uuid[],
  audience text[],
  locale text,
  revision_no integer,
  source_system hub.content_source,
  route_pattern text,
  video_status text,
  course_launch_path text,
  placements jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with accessible_publications as (
    select
      publication.id as publication_id,
      publication.item_id,
      publication.revision_id,
      publication.product_id,
      publication.audience,
      publication.route_pattern
    from hub.content_publications publication
    join hub.content_items item
      on item.id = publication.item_id
    join hub.content_revisions revision
      on revision.id = publication.revision_id
     and revision.item_id = publication.item_id
    join hub.products product
      on product.id = publication.product_id
    where item.status = 'published'
      and revision.review_state = 'approved'
      and product.status <> 'retired'
      and product.support_enabled
      and (revision.product_overlay_id is null or revision.product_overlay_id = publication.product_id)
      and publication.published_at <= now()
      and (publication.expires_at is null or publication.expires_at > now())
      and private.can_access_content_publication(
        publication.item_id,
        publication.revision_id,
        publication.product_id
      )
  ),
  grouped_publications as (
    select
      publication.item_id,
      publication.revision_id,
      array_agg(distinct publication.product_id) as product_ids,
      array_agg(distinct audience_item)
        filter (where audience_item is not null) as audience,
      case
        when count(distinct publication.route_pattern)
          filter (where publication.route_pattern is not null) <= 1
        then min(publication.route_pattern)
        else null
      end as route_pattern,
      jsonb_agg(
        jsonb_build_object(
          'product_id', publication.product_id,
          'audience', publication.audience,
          'route_pattern', publication.route_pattern
        )
        order by publication.product_id
      ) as placements
    from accessible_publications publication
    left join lateral unnest(publication.audience) as audience_item on true
    group by publication.item_id, publication.revision_id
  )
  select
    revision.id,
    item.content_key,
    item.kind,
    revision.title,
    revision.summary,
    revision.body_markdown,
    item.status,
    item.access_level,
    grouped.product_ids,
    coalesce(grouped.audience, array[]::text[]) as audience,
    revision.locale,
    revision.revision_no,
    item.source_system,
    grouped.route_pattern,
    media.render_status as video_status,
    course.launch_path as course_launch_path,
    grouped.placements
  from grouped_publications grouped
  join hub.content_items item
    on item.id = grouped.item_id
  join hub.content_revisions revision
    on revision.id = grouped.revision_id
  left join lateral (
    select asset.render_status
    from hub.media_assets asset
    where asset.content_item_id = grouped.item_id
      and asset.revision_id = grouped.revision_id
      and private.can_view_media_asset(asset.id)
      and exists (
        select 1
        from accessible_publications publication
        where publication.item_id = asset.content_item_id
          and publication.revision_id = asset.revision_id
          and (asset.product_id is null or asset.product_id = publication.product_id)
      )
    order by
      (asset.published_at is not null) desc,
      asset.published_at desc nulls last,
      case asset.render_status
        when 'ready' then 1
        when 'review' then 2
        when 'rendering' then 3
        when 'failed' then 4
        when 'retired' then 5
        else 6
      end,
      asset.created_at desc,
      asset.id desc
    limit 1
  ) media on true
  left join hub.course_links course
    on course.content_item_id = item.id
  order by revision.title;
$$;

revoke all on function hub.list_published_content()
from public, anon, authenticated;
grant execute on function hub.list_published_content()
to anon, authenticated;
