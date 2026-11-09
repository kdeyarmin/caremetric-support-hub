-- A product's public help articles, for that product's own website. The Content Marketer publishes one public article a week to
-- the help center (docs/AI_TEAM.md, "The Content Marketer"); the ones about CareMetric Intel are served by Intel's website at
-- https://www.caremetricintel.com/resources/<content key>, which reads them from the Hub's public feed
-- (GET /api/public/articles?product=caremetric-intel, server/public-articles.mjs).
--
-- The read returns exactly what an anonymous visitor of the help center can already read, for one product: an article (kind
-- article) that is published, public and published for every visitor (audience "all"), whose current approved revision is live
-- (published, not expired) under a product that is not retired and is open to support, the same conditions under which
-- hub.list_published_content shows it to an anonymous visitor (private.can_access_content_publication, which does not tie a
-- publication to the item's owner product). An article counts as the product's only when every such publication
-- of it is for that product, so an article shared with another product stays the help center's. Drafts, revisions waiting for
-- review, customer or staff articles, and anything retired or expired are never returned.
--
-- Boundary: no new table; one security definer with a pinned empty search path that refuses every session user except
-- hub_app_server, executable by the Hub server alone. It returns the content key, title, description (the revision's summary),
-- Markdown body, locale, revision number and the publication's times, never an id, an author, an approver, the revision's
-- variables or anything about the publishing action.

create function private.public_articles(p_product text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_product is null or p_product !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(p_product) > 80 then
    raise exception 'Unknown product.' using errcode = '22023';
  end if;
  return coalesce((
    with visible as (
      select item.id as item_id, item.content_key, publication.revision_id, publication.published_at, product.slug as product
      from hub.content_publications publication
      join hub.content_items item on item.id = publication.item_id
      join hub.content_revisions revision on revision.id = publication.revision_id and revision.item_id = publication.item_id
      join hub.products product on product.id = publication.product_id
      where item.kind = 'article'
        and item.status = 'published'
        and item.access_level = 'public'
        and revision.review_state = 'approved'
        and product.status <> 'retired'
        and product.support_enabled
        and (revision.product_overlay_id is null or revision.product_overlay_id = publication.product_id)
        and publication.published_at <= now()
        and (publication.expires_at is null or publication.expires_at > now())
        and 'all' = any(coalesce(publication.audience, array[]::text[]))
    ),
    owned as (
      select v.item_id from visible v group by v.item_id having bool_and(v.product = p_product)
    )
    select jsonb_agg(jsonb_build_object(
        'key', v.content_key,
        'title', revision.title,
        'description', revision.summary,
        'markdown', coalesce(revision.body_markdown, ''),
        'locale', revision.locale,
        'revision', revision.revision_no,
        'publishedAt', v.published_at,
        'updatedAt', greatest(v.published_at, revision.approved_at))
      order by v.published_at desc, v.content_key)
    from visible v
    join owned o on o.item_id = v.item_id
    join hub.content_revisions revision on revision.id = v.revision_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function private.public_articles(text) from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.public_articles(text) to hub_app_server;
