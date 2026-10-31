begin;
select plan(9);

select ok(exists(select 1 from hub.products where slug='advisors' and status='active' and support_enabled),
  'Healthcare Advisors is a registered, support-enabled product');
select ok((select pg_get_constraintdef(oid) like '%''advisors''%' and pg_get_constraintdef(oid) like '%''intel''%'
    and pg_get_constraintdef(oid) like '%carebase.learning%' and pg_get_constraintdef(oid) like '%publication%'
  from pg_constraint where conname='app_delegations_audience_check'),
  'the Advisors audience is added without dropping any existing capability audience');
select is((select count(*) from hub.content_publications p join hub.products pr on pr.id=p.product_id
    join hub.content_items i on i.id=p.item_id where pr.slug='advisors' and i.kind='course'),0::bigint,
  'a consulting practice receives no course placements');
select is((select count(*) from hub.content_publications p join hub.products pr on pr.id=p.product_id
    join hub.content_items i on i.id=p.item_id where pr.slug='advisors' and i.content_key='account.invite-user'),0::bigint,
  'the software team-invitation article is not placed on Advisors');
select is((select count(*) from hub.content_items where content_key like 'advisors.faq.%' and status='published'
    and access_level='public' and source_system='legacy'),11::bigint,
  'all eleven published Advisors FAQ answers are imported once');
select is((select count(distinct r.source_version) from hub.content_revisions r join hub.content_items i on i.id=r.item_id
    where i.content_key like 'advisors.faq.%' and r.review_state='approved'
      and r.source_version='advisors@37afa7a884dc70f52d1134a7a27927ffee847373:site-content.mjs#faqs'),1::bigint,
  'every FAQ revision is pinned to its exact source commit');

set local role anon;
select is((select count(*) from hub.list_published_content() c
    where c.product_ids @> array['00000000-0000-4000-8000-000000000007'::uuid]),12::bigint,
  'anonymous visitors see the eleven FAQ answers and the shared safety article for Advisors');
reset role;

select ok(not has_table_privilege('anon','private.app_delegations','select')
  and not has_table_privilege('authenticated','private.app_delegations','select'),
  'browser roles still cannot read delegation capabilities');
select ok(hub.get_backend_contract()->'features' @> '["platform.admin.advisors.v1"]'::jsonb,
  'the Advisors bridge is declared in release metadata');

select * from finish();
rollback;
