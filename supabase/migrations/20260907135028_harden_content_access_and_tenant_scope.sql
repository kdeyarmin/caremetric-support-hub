create or replace function private.can_view_tenant(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and (
      exists (
        select 1
        from hub.tenant_product_memberships membership
        where membership.user_id = (select auth.uid())
          and membership.tenant_id = p_tenant_id
          and membership.status = 'active'
          and membership.revoked_at is null
          and private.is_active_member(membership.tenant_id, membership.product_id)
      )
      or private.has_staff_permission('tenant.manage', null)
      or exists (
        select 1
        from hub.tenant_products entitlement
        where entitlement.tenant_id = p_tenant_id
          and (
            private.has_staff_permission('case.read', entitlement.product_id)
            or private.has_staff_permission('case.write', entitlement.product_id)
            or private.has_staff_permission('tenant.manage', entitlement.product_id)
          )
      )
    );
$$;

create or replace function private.has_active_content_audience(
  p_product_id uuid,
  p_audience text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from hub.tenant_product_memberships membership
      join hub.tenant_products entitlement
        on entitlement.tenant_id = membership.tenant_id
       and entitlement.product_id = membership.product_id
      join hub.tenants tenant on tenant.id = membership.tenant_id
      join hub.products product on product.id = membership.product_id
      where membership.user_id = (select auth.uid())
        and membership.product_id = p_product_id
        and membership.status = 'active'
        and membership.revoked_at is null
        and entitlement.status = 'active'
        and tenant.status = 'active'
        and product.status <> 'retired'
        and product.support_enabled
        and (
          'all' = any(coalesce(p_audience, array[]::text[]))
          or (
            membership.role = 'tenant_admin'
            and coalesce(p_audience, array[]::text[]) && array['customer-admin', 'manager']::text[]
          )
          or (
            membership.role = 'customer'
            and 'customer' = any(coalesce(p_audience, array[]::text[]))
          )
        )
    );
$$;

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
    where publication.item_id = p_item_id
      and publication.revision_id = p_revision_id
      and publication.product_id = p_product_id
      and (item.owner_product_id is null or item.owner_product_id = publication.product_id)
      and (revision.product_overlay_id is null or revision.product_overlay_id = publication.product_id)
      and (
        private.has_staff_permission('content.read', publication.product_id)
        or private.has_staff_permission('content.write', publication.product_id)
        or (
          item.status = 'published'
          and revision.review_state = 'approved'
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

create or replace function private.can_view_content_item(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from hub.content_items item
    where item.id = p_item_id
      and (
        private.has_staff_permission('content.read', item.owner_product_id)
        or private.has_staff_permission('content.write', item.owner_product_id)
        or exists (
          select 1
          from hub.content_publications publication
          where publication.item_id = item.id
            and private.can_access_content_publication(
              publication.item_id,
              publication.revision_id,
              publication.product_id
            )
        )
      )
  );
$$;

create or replace function private.can_view_content_revision(p_revision_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from hub.content_revisions revision
    join hub.content_items item on item.id = revision.item_id
    where revision.id = p_revision_id
      and (
        private.has_staff_permission(
          'content.read',
          coalesce(revision.product_overlay_id, item.owner_product_id)
        )
        or private.has_staff_permission(
          'content.write',
          coalesce(revision.product_overlay_id, item.owner_product_id)
        )
        or exists (
          select 1
          from hub.content_publications publication
          where publication.item_id = revision.item_id
            and publication.revision_id = revision.id
            and private.can_access_content_publication(
              publication.item_id,
              publication.revision_id,
              publication.product_id
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

revoke all on function private.can_view_tenant(uuid) from public, anon, authenticated;
revoke all on function private.has_active_content_audience(uuid, text[]) from public, anon, authenticated;
revoke all on function private.can_access_content_publication(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.can_view_content_item(uuid) from public, anon, authenticated;
revoke all on function private.can_view_content_revision(uuid) from public, anon, authenticated;
revoke all on function private.can_view_media_asset(uuid) from public, anon, authenticated;

grant execute on function private.can_view_tenant(uuid) to authenticated;
grant execute on function private.can_access_content_publication(uuid, uuid, uuid) to anon, authenticated;
grant execute on function private.can_view_content_item(uuid) to anon, authenticated;
grant execute on function private.can_view_content_revision(uuid) to anon, authenticated;
grant execute on function private.can_view_media_asset(uuid) to anon, authenticated;

drop policy if exists tenants_member_read on hub.tenants;
create policy tenants_member_read on hub.tenants
for select to authenticated
using (private.can_view_tenant(id));

drop policy if exists content_items_read on hub.content_items;
create policy content_items_read on hub.content_items
for select to anon, authenticated
using (private.can_view_content_item(id));

drop policy if exists content_revisions_read on hub.content_revisions;
create policy content_revisions_read on hub.content_revisions
for select to anon, authenticated
using (private.can_view_content_revision(id));

drop policy if exists content_publications_read on hub.content_publications;
create policy content_publications_read on hub.content_publications
for select to anon, authenticated
using (
  private.can_access_content_publication(item_id, revision_id, product_id)
);

drop policy if exists media_assets_read on hub.media_assets;
create policy media_assets_read on hub.media_assets
for select to anon, authenticated
using (private.can_view_media_asset(id));

create or replace function hub.list_published_content()
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
  course_launch_path text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    revision.id,
    item.content_key,
    item.kind,
    revision.title,
    revision.summary,
    revision.body_markdown,
    item.status,
    item.access_level,
    array_agg(distinct publication.product_id) as product_ids,
    array_agg(distinct audience_item)
      filter (where audience_item is not null) as audience,
    revision.locale,
    revision.revision_no,
    item.source_system,
    min(publication.route_pattern) as route_pattern,
    max(media.render_status) as video_status,
    max(course.launch_path) as course_launch_path
  from hub.content_items item
  join hub.content_publications publication
    on publication.item_id = item.id
  join hub.content_revisions revision
    on revision.id = publication.revision_id
   and revision.item_id = publication.item_id
  left join lateral unnest(publication.audience) as audience_item on true
  left join hub.media_assets media
    on media.content_item_id = item.id
   and media.revision_id = revision.id
   and (media.product_id is null or media.product_id = publication.product_id)
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
  left join hub.course_links course
    on course.content_item_id = item.id
  where item.status = 'published'
    and revision.review_state = 'approved'
    and publication.published_at <= now()
    and (publication.expires_at is null or publication.expires_at > now())
    and private.can_access_content_publication(
      publication.item_id,
      publication.revision_id,
      publication.product_id
    )
  group by item.id, revision.id
  order by revision.title;
$$;

revoke all on function hub.list_published_content() from public, anon, authenticated;
grant execute on function hub.list_published_content() to anon, authenticated;
