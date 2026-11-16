begin;
select no_plan();
select is((select count(*)::integer from hub.content_publications cp join hub.content_items i on i.id=cp.item_id join hub.products p on p.id=cp.product_id where p.slug='pennsync' and i.content_key='self-service.subscriptions'),0,'PennSync does not receive payment instructions in search, AI or manuals');
-- PennSync left the central Hub (20261028220500): it uses native support, so no Hub self-service guide is published to it
-- (20261117100100_self_service_guides.sql). Its historical memberships and cases are kept.
select is((select count(*)::integer from hub.content_publications cp join hub.content_items i on i.id=cp.item_id join hub.products p on p.id=cp.product_id where p.slug='pennsync' and i.content_key like 'self-service.%'),0,'PennSync, which uses native support, gets no Hub self-service guidance');
select ok(exists(select 1 from hub.content_publications cp join hub.content_items i on i.id=cp.item_id join hub.products p on p.id=cp.product_id where p.slug='carebase' and i.content_key='self-service.subscriptions'),'other applications keep their payment guidance');
select * from finish();
rollback;
