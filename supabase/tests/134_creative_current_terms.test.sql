begin;
select plan(6);

insert into private.creative_briefs (id, product, goal, audience, platforms, source, request_key)
values ('0134aaaa-0000-4000-8000-000000000001', 'caremetric-intel', 'Free trial', 'Home health agency owners', array['meta'], 'owner', 'pgtap-creative-current-terms');
insert into private.creative_assets (id, brief_id, product, platform, placement, kind, layout, width, height, variant_label, hook_type,
  headline, primary_text, description, cta, landing_url, alt_text, overlay, status, public_token, approved_at)
select ('0134bbbb-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, '0134aaaa-0000-4000-8000-000000000001',
  'caremetric-intel', 'meta', 'meta.feed_square', 'static', 'headline', 1080, 1080, 'Test ' || n, 'offer',
  'Rank the agencies in your territory', 'Rank the home health agencies in your territory.', 'Free trial', 'Start free trial',
  'https://www.caremetricintel.com/?utm_content=test', 'An ember-toned ad', jsonb_build_object('beats', jsonb_build_array('Try Intel free for 14 days')),
  state, case when state in ('approved', 'live') then repeat(n::text,64) else null end, now() - interval '1 day'
from (values (1, 'approved'), (2, 'live'), (3, 'retired')) as fixture(n, state);

select throws_ok($$select private.creative_approved('caremetric-intel', 'meta', 20)$$, '42501', null, 'Non-server sessions cannot read approved creative');
select ok(not bool_or(has_function_privilege(r, 'private.creative_approved(text,text,integer)', 'execute')
  or has_function_privilege(r, 'private.creative_live_assets(text[])', 'execute')), 'Both readers remain server-only')
from unnest(array['anon', 'authenticated', 'service_role']) r;

-- Supabase's test admin is not a superuser and cannot change session authorization (as in 121_campaign_creative_validation).
create or replace function private.require_hub_app_server() returns void
language plpgsql stable set search_path = '' as $$ begin return; end; $$;
create temporary table creative_terms_approved as select private.creative_approved('caremetric-intel', 'meta', 20) as assets;
create temporary table creative_terms_live as select private.creative_live_assets(array['caremetric-intel']) as assets;

select is((select a->'overlay' from creative_terms_approved, jsonb_array_elements(assets) a where a->>'id' = '0134bbbb-0000-4000-8000-000000000001'),
  jsonb_build_object('beats', jsonb_build_array('Try Intel free for 14 days')), 'Approved creative carries the text on its image');
select is((select a->>'layout' from creative_terms_approved, jsonb_array_elements(assets) a where a->>'id' = '0134bbbb-0000-4000-8000-000000000001'),
  'headline', 'Approved creative carries its layout');
select ok((select bool_and(a ? 'overlay' and a ? 'altText') from creative_terms_live, jsonb_array_elements(assets) a
  where a->>'briefId' = '0134aaaa-0000-4000-8000-000000000001'), 'Approved and live creative in the snapshot carry their image text and alt text');
select is((select count(*)::integer from creative_terms_live, jsonb_array_elements(assets) a where a->>'briefId' = '0134aaaa-0000-4000-8000-000000000001'), 2,
  'The snapshot still returns approved and live creative only');

select * from finish();
rollback;
