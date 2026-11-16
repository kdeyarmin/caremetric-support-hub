begin;
select plan(6);

-- The maintained guides (docs/self-service/guides.json), as the newest generated migration publishes them
-- (scripts/self-service-guides.mjs). Only CareBase, Breathe and Intel use the central Hub's self-service
-- (docs/self-service/README.md); PennSync, EMR, Go and Healthcare Advisors use native support.
select is((select count(*)::integer from hub.content_items where content_key like 'self-service.%'), 7, 'Seven maintained guides');
select is((select count(*)::integer from hub.content_publications cp join hub.content_items i on i.id = cp.item_id
  join hub.products p on p.id = cp.product_id
  where i.content_key like 'self-service.%' and p.slug not in ('carebase', 'breathe', 'caremetric-intel')), 0,
  'No guide is published to an application that uses native support');
select is((select array_agg(p.slug order by p.slug) from hub.content_publications cp join hub.content_items i on i.id = cp.item_id
  join hub.products p on p.id = cp.product_id where i.content_key = 'self-service.employee-access'), array['carebase'],
  'Employee account recovery is CareBase''s alone');
select is((select array_agg(p.slug order by p.slug) from hub.content_publications cp join hub.content_items i on i.id = cp.item_id
  join hub.products p on p.id = cp.product_id where i.content_key = 'self-service.support-requests'), array['breathe', 'carebase', 'caremetric-intel'],
  'A shared guide is published in each application it names');
-- Every publication shows the newest revision, and a guide whose text did not change kept the revision it had.
select is((select count(*)::integer from hub.content_publications cp join hub.content_items i on i.id = cp.item_id
  where i.content_key like 'self-service.%'
    and cp.revision_id <> (select r.id from hub.content_revisions r where r.item_id = i.id order by r.revision_no desc limit 1)), 0,
  'Each guide is published at its newest revision');
select is((select count(*)::integer from (select 1 from hub.content_revisions r join hub.content_items i on i.id = r.item_id
  where i.content_key like 'self-service.%' group by r.item_id, r.locale, r.title, r.summary, r.body_markdown, r.variables having count(*) > 1) same), 0,
  'A guide never gets a second revision with the same text');

select * from finish();
rollback;
