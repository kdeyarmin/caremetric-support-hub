-- Supply the approved copy and image identity for campaign execution checks, including already-live assets.
-- Existing server-only privileges, approval rules and targeting settings are unchanged.
create or replace function private.creative_live_assets(p_products text[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'briefId', a.brief_id, 'product', a.product, 'platform', a.platform, 'placement', a.placement,
      'token', a.public_token, 'primaryText', a.primary_text, 'description', a.description, 'cta', a.cta, 'landingUrl', a.landing_url,
      'kind', a.kind, 'layout', a.layout, 'hookType', a.hook_type, 'lengthKey', a.length_key, 'status', a.status, 'headline', a.headline,
      'variantLabel', a.variant_label, 'approvedAt', a.approved_at, 'liveAt', a.live_at, 'liveRef', a.live_ref, 'performance', a.performance) order by a.approved_at)
    from private.creative_assets a where a.status in ('approved', 'live') and a.product = any(coalesce(p_products, array['carebase', 'caremetric-intel']))), '[]'::jsonb);
end;
$$;
