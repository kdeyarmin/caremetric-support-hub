-- County snapshots are retired (owner decision 2026-11-20): no marketing names one county unless it is shown only in that county. Every
-- campaign the Hub creates targets the roster's whole states, the daily ad review puts approved images into those campaigns, and the
-- Social Media Manager posts them on the company pages, so an image such as "41% of Medicare beneficiaries in Bucks County, PA are in
-- Medicare Advantage" was shown across Pennsylvania and the other roster states. The release that applies this stops drawing them (the
-- daily plan opens none, and Settings → Creative → "County snapshots a week" is retired); this takes the ones already drawn out of use.
--
-- A county brief is a snapshot (source data.county) or a revision or refresh made from one of its images, at any depth: those carry the
-- county's words in their angle. Their images, whatever their state, are retired (approved and live ones lose their public address, so no
-- ad, campaign or post can use them again); their approvals still waiting are withdrawn; an ad, campaign or post proposed or approved
-- with one of them and not yet carried out is withdrawn too; and their briefs still open are cancelled. An ad already running on Meta or
-- LinkedIn keeps the copy of the image the platform made: the owner pauses it there. Nothing else is touched.
set local lock_timeout = '10s';

do $$
declare
  v_briefs uuid[];
  v_assets uuid[];
  v_retired integer;
  v_approvals integer;
  v_withdrawn integer;
  v_stopped integer;
  v_cancelled integer;
begin
  with recursive chain(id) as (
    select b.id from private.creative_briefs b where b.source = 'data.county'
    union
    select b.id from private.creative_briefs b
      join private.creative_assets a on a.id = b.parent_asset_id
      join chain c on c.id = a.brief_id
  )
  select coalesce(array_agg(id), array[]::uuid[]) into v_briefs from chain;
  select coalesce(array_agg(a.id), array[]::uuid[]) into v_assets from private.creative_assets a where a.brief_id = any(v_briefs);

  -- The images first, so withdrawing their approvals below leaves them retired rather than expired. A blocked image is retired too, or
  -- the work recovery (creative_render_requeue) could render it again.
  update private.creative_assets
     set status = 'retired', public_token = null, retired_at = coalesce(retired_at, now()), updated_at = now()
   where id = any(v_assets) and status in ('draft', 'rendering', 'ready', 'blocked', 'proposed', 'approved', 'live')
     and (kind = 'static' or duration_seconds is not null);
  get diagnostics v_retired = row_count;

  -- Their approvals still waiting for the owner.
  update private.agent_actions set status = 'expired', updated_at = now()
   where kind in ('creative.asset', 'creative.asset_review') and status = 'proposed' and target_id = any(v_assets::text[]);
  get diagnostics v_approvals = row_count;

  -- Ads, campaigns and posts proposed with one of them, not yet carried out.
  update private.agent_actions set status = 'expired', updated_at = now()
   where kind like 'social.%' and status = 'proposed'
     and (input ->> 'creativeAssetId' = any(v_assets::text[]) or input #>> '{firstAd,creativeAssetId}' = any(v_assets::text[]));
  get diagnostics v_withdrawn = row_count;

  -- The same, approved but waiting for their time: they would publish an image whose address is gone.
  update private.agent_actions
     set status = 'failed', result = jsonb_build_object('error', 'county_snapshot_retired'), updated_at = now()
   where kind like 'social.%' and status in ('approved', 'auto_approved')
     and (input ->> 'creativeAssetId' = any(v_assets::text[]) or input #>> '{firstAd,creativeAssetId}' = any(v_assets::text[]));
  get diagnostics v_stopped = row_count;

  -- Their briefs still open or drafting: a queued drafting task finds its brief cancelled and does nothing (creative.request).
  update private.creative_briefs
     set status = 'cancelled', result = jsonb_build_object('reason', 'county_snapshot_retired'), updated_at = now()
   where id = any(v_briefs) and status in ('open', 'drafting');
  get diagnostics v_cancelled = row_count;

  insert into private.audit_events (actor_id, action, entity_type, entity_id, metadata)
  values (null, 'creative.county_snapshots_retired', 'creative_asset', null,
    jsonb_build_object('briefs', cardinality(v_briefs), 'assetsRetired', v_retired, 'approvalsWithdrawn', v_approvals,
      'adsAndPostsWithdrawn', v_withdrawn + v_stopped, 'briefsCancelled', v_cancelled));
end $$;
