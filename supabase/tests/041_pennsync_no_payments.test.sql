begin;
select no_plan();
select is((select count(*)::integer from hub.content_publications cp join hub.content_items i on i.id=cp.item_id join hub.products p on p.id=cp.product_id where p.slug='pennsync' and i.content_key='self-service.subscriptions'),0,'PennSync does not receive payment instructions in search, AI or manuals');
select ok(exists(select 1 from hub.content_publications cp join hub.content_items i on i.id=cp.item_id join hub.products p on p.id=cp.product_id where p.slug='pennsync' and i.content_key='self-service.training-profile'),'PennSync keeps its published training guidance');
select ok(exists(select 1 from hub.content_publications cp join hub.content_items i on i.id=cp.item_id join hub.products p on p.id=cp.product_id where p.slug='carebase' and i.content_key='self-service.subscriptions'),'other applications keep their payment guidance');
select * from finish();
rollback;
