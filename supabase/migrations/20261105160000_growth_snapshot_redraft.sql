-- The pipeline's snapshot also says, for each work item's last message, whether it was withdrawn and which opportunity, contact and
-- policy versions it was drafted against. The Marketing Manager's sweep uses them to skip work whose last message was cancelled for a
-- lasting reason (the contact unsubscribed, the business replied, the business was already contacted) while nothing has changed: a new
-- draft would pay for a model call and get the same cancelled message back from private.growth_draft, every fifteen minutes. A withdrawn
-- message (20261105150000) or any change of version still opens the work to a new draft. Nothing else in the snapshot changes, and the
-- function keeps its signature, owner and grants (Hub server only).
create or replace function private.growth_snapshot(p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$ begin
 perform private.require_hub_app_server();
 if p_offset is null or p_offset<0 then raise exception 'Invalid offset' using errcode='22023'; end if;
 return jsonb_build_object('total',(select count(*) from private.growth_opportunities),'items',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (
 select o.*,g.name,g.domain,g.internal,g.tenant_id,c.name as contact_name,c.eligibility,c.verified_at,c.version as contact_version,
 (select to_jsonb(p) from private.growth_policies p where p.product=o.product) as policy,
 (select coalesce(jsonb_agg(to_jsonb(e)),'[]') from (select id,source_url,claim,confidence,observed_at from private.growth_evidence where opportunity_id=o.id order by observed_at desc limit 20) e) as evidence,
 (select coalesce(jsonb_agg(to_jsonb(e)),'[]') from (select kind,occurred_at,facts from private.customer_activity_events where organization_id=o.organization_id and product=o.product and occurred_at>now()-interval '90 days' order by occurred_at desc limit 500) e) as events,
 (select coalesce(jsonb_agg(to_jsonb(w)),'[]') from (select w.*,m.id as message_id,m.status as message_status,m.withdrawn_at is not null as message_withdrawn,m.opportunity_version as message_opportunity_version,m.contact_version as message_contact_version,m.policy_version as message_policy_version from private.customer_success_plans w left join lateral(select m1.* from private.growth_messages m1 where m1.work_id=w.id order by m1.created_at desc limit 1) m on true where w.opportunity_id=o.id) w) as work,
 (select count(*) from private.growth_messages m where m.opportunity_id=o.id and m.purpose='marketing' and m.attempted_at is not null) as touches,
 (select max(m.attempted_at) from private.growth_messages m where m.contact_id=o.contact_id) as last_touch
 from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id left join private.growth_contacts c on c.id=o.contact_id order by o.id limit 100 offset p_offset) x));
end; $$;
