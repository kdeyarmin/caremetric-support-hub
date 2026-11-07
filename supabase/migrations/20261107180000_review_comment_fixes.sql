-- Fixes from the review of the November 7 feature review pull request. Function replacements keep their signatures, so grants
-- are kept.
--
-- CareMetric PennSync courses for product members. Courses placed on PennSync reach its learners (20261107160000), but only
-- public ones did: a course for product members checks private.has_active_content_audience, which also requires the product to
-- be live with support enabled, and PennSync keeps its own support and billing closed. A members-only PennSync course is now
-- checked against the same membership rules (an active membership of an active tenant with an active entitlement, the
-- publication's audience, and the multi-factor rule) without the support conditions. Nothing changes for any other product.
create or replace function private.has_active_course_audience(p_product_id uuid, p_audience text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and (not private.current_principal_requires_aal2() or private.current_session_is_aal2())
    and exists (
      select 1
      from hub.tenant_product_memberships membership
      join hub.tenant_products entitlement
        on entitlement.tenant_id = membership.tenant_id
       and entitlement.product_id = membership.product_id
      join hub.tenants tenant on tenant.id = membership.tenant_id
      where membership.user_id = (select auth.uid())
        and membership.product_id = p_product_id
        and membership.status = 'active'
        and membership.revoked_at is null
        and entitlement.status = 'active'
        and tenant.status = 'active'
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
revoke all on function private.has_active_course_audience(uuid, text[]) from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.can_access_content_publication(p_item_id uuid, p_revision_id uuid, p_product_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      and (item.kind<>'course' or item.source_system<>'penntrain' or private.course_distribution_available(item.id,revision.id))
      and (revision.product_overlay_id is null or revision.product_overlay_id = publication.product_id)
      and (
        private.has_staff_permission('content.read', publication.product_id)
        or private.has_staff_permission('content.write', publication.product_id)
        or (
          item.status = 'published'
          and revision.review_state = 'approved'
          -- A retired application or one without support publishes nothing, except CareMetric PennSync courses: PennSync keeps its
          -- own support and billing closed, but courses placed on it reach its learners.
          and (
            (publication_product.status <> 'retired' and publication_product.support_enabled)
            or (item.kind = 'course' and publication_product.slug = 'pennsync')
          )
          and publication.published_at <= now()
          and (publication.expires_at is null or publication.expires_at > now())
          and (
            (
              item.access_level = 'public'
              and 'all' = any(coalesce(publication.audience, array[]::text[]))
            )
            or (
              item.access_level = 'customer'
              and (
                private.has_active_content_audience(publication.product_id, publication.audience)
                -- PennSync fails the support checks in has_active_content_audience by design; its members still reach its courses.
                or (item.kind = 'course' and publication_product.slug = 'pennsync'
                  and private.has_active_course_audience(publication.product_id, publication.audience))
              )
            )
          )
        )
      )
  );
$function$;

notify pgrst, 'reload schema';
