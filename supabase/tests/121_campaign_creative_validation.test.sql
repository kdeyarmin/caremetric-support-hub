begin;
select plan(5);

insert into private.creative_briefs (id, product, goal, audience, platforms, source, request_key)
values ('0117aaaa-0000-4000-8000-000000000001', 'caremetric-intel', 'Free county reports', 'Home health agency owners', array['linkedin'], 'owner', 'pgtap-campaign-creative');
insert into private.creative_assets (id, brief_id, product, platform, placement, kind, layout, width, height, variant_label, hook_type,
  headline, primary_text, description, cta, landing_url, status, public_token)
select ('0117bbbb-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, '0117aaaa-0000-4000-8000-000000000001',
  'caremetric-intel', 'linkedin', 'linkedin.single_image', 'static', 'headline', 1200, 628, 'Test ' || n, 'offer',
  'Your agency market report', 'See your agency alongside the other home health agencies in its county.', 'Free market report', 'Get your report',
  'https://www.caremetricintel.com/county-report?utm_content=test', state, case when state in ('approved', 'live') then repeat(n::text,64) else null end
from (values (1, 'approved'), (2, 'live'), (3, 'retired')) as fixture(n, state);

select throws_ok($$select private.creative_live_assets(array['caremetric-intel'])$$, '42501', null, 'Non-server sessions cannot read the creative snapshot');
select ok(not bool_or(has_function_privilege(r, 'private.creative_live_assets(text[])', 'execute')), 'The expanded snapshot remains server-only')
from unnest(array['anon', 'authenticated', 'service_role']) r;

-- Supabase's test admin is not a superuser and cannot change session authorization.
-- After testing the real guard above, follow the suite's transaction-local fixture pattern; rollback restores it.
create or replace function private.require_hub_app_server() returns void
language plpgsql stable set search_path = '' as $$ begin return; end; $$;
create temporary table campaign_creative_snapshot as select private.creative_live_assets(array['caremetric-intel']) as assets;
select is((select count(*)::integer from campaign_creative_snapshot, jsonb_array_elements(assets) a where a->>'briefId' = '0117aaaa-0000-4000-8000-000000000001'), 2,
  'Only approved and live creative is returned, never retired creative');
select ok((select bool_and(a @> jsonb_build_object('primaryText', 'See your agency alongside the other home health agencies in its county.',
  'description', 'Free market report', 'cta', 'Get your report', 'landingUrl', 'https://www.caremetricintel.com/county-report?utm_content=test'))
  from campaign_creative_snapshot, jsonb_array_elements(assets) a where a->>'briefId' = '0117aaaa-0000-4000-8000-000000000001'),
  'Both approved and live assets include the exact offer and copy for execution validation');
select ok((select bool_and(a->>'token' = case a->>'status' when 'approved' then repeat('1',64) else repeat('2',64) end)
  from campaign_creative_snapshot, jsonb_array_elements(assets) a where a->>'briefId' = '0117aaaa-0000-4000-8000-000000000001'),
  'The exact approved image token is returned');

select * from finish();
rollback;
