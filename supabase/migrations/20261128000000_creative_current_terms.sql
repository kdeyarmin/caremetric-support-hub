-- The two readers of approved creative also return the text on the image or video (`overlay`) and the layout, so the Hub can check an
-- approved asset against today's prices, offers and trial before it is posted or put in an ad (server/agents/creative/compliance.mjs,
-- outdatedTerms). Creative approved under old terms ("Try Intel free for 14 days", "Founders Sale: 50% off") was posted after the trial
-- and the sale changed. Privileges, the server-only guard and the rows each reader returns are unchanged; only fields are added.
create or replace function private.creative_approved(p_product text, p_platform text, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'token', a.public_token, 'product', a.product, 'platform', a.platform,
      'placement', a.placement, 'kind', a.kind, 'width', a.width, 'height', a.height, 'contentType', a.content_type, 'headline', a.headline,
      'primaryText', a.primary_text, 'description', a.description, 'cta', a.cta, 'landingUrl', a.landing_url, 'altText', a.alt_text,
      'hookType', a.hook_type, 'layout', a.layout, 'overlay', a.overlay) order by a.approved_at)
    from (select * from private.creative_assets where status = 'approved' and product = p_product and platform = p_platform
          order by approved_at limit least(greatest(coalesce(p_limit, 5), 1), 20)) a), '[]'::jsonb);
end;
$$;

create or replace function private.creative_live_assets(p_products text[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'briefId', a.brief_id, 'product', a.product, 'platform', a.platform, 'placement', a.placement,
      'token', a.public_token, 'primaryText', a.primary_text, 'description', a.description, 'cta', a.cta, 'landingUrl', a.landing_url,
      'kind', a.kind, 'layout', a.layout, 'hookType', a.hook_type, 'lengthKey', a.length_key, 'status', a.status, 'headline', a.headline,
      'variantLabel', a.variant_label, 'approvedAt', a.approved_at, 'liveAt', a.live_at, 'liveRef', a.live_ref, 'performance', a.performance,
      'altText', a.alt_text, 'overlay', a.overlay) order by a.approved_at)
    from private.creative_assets a where a.status in ('approved', 'live') and a.product = any(coalesce(p_products, array['carebase', 'caremetric-intel']))), '[]'::jsonb);
end;
$$;
