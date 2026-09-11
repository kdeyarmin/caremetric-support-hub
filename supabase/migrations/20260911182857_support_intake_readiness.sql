-- Readiness is measured from current access, not static rollout labels.
-- This migration grants no memberships and enables no customer intake.
create function private.support_usable_member_count(p_tenant uuid,p_product uuid) returns bigint
language sql stable security definer set search_path='' as $$
  select count(*) from hub.tenant_product_memberships m
  join hub.profiles profile on profile.id=m.user_id
  join auth.users u on u.id=m.user_id
  join private.sms_identities sms on sms.user_id=m.user_id
  where m.tenant_id=p_tenant and m.product_id=p_product
    and m.status='active' and m.revoked_at is null
    and u.deleted_at is null and not coalesce(u.is_anonymous,false)
    and (u.banned_until is null or u.banned_until<=now())
    and sms.verified_at is not null and sms.revoked_at is null;
$$;
revoke all on function private.support_usable_member_count(uuid,uuid) from public,anon,authenticated;

create function hub.get_support_readiness() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform hub.authorize_app_admin();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'slug',p.slug,'name',p.name,'status',p.status,'supportEnabled',p.support_enabled,
    'activeTenantCount',(select count(*) from hub.tenant_products tp join hub.tenants t on t.id=tp.tenant_id
      where tp.product_id=p.id and tp.status='active' and t.status='active'),
    'usableMemberCount',(select coalesce(sum(private.support_usable_member_count(tp.tenant_id,p.id)),0)
      from hub.tenant_products tp join hub.tenants t on t.id=tp.tenant_id
      where tp.product_id=p.id and tp.status='active' and t.status='active'),
    'readyTenantCount',(select count(*) from hub.tenant_products tp where tp.product_id=p.id
      and private.is_case_intake_enabled(tp.tenant_id,p.id)
      and private.support_usable_member_count(tp.tenant_id,p.id)>0),
    'publishedItemCount',(select count(distinct publication.item_id) from hub.content_publications publication
      join hub.content_items item on item.id=publication.item_id
      join hub.content_revisions revision on revision.id=publication.revision_id
      where publication.product_id=p.id and item.status='published' and revision.review_state='approved'
        and publication.published_at<=now() and (publication.expires_at is null or publication.expires_at>now()))
  ) order by p.name),'[]'::jsonb) into result
  from hub.products p where p.slug in ('carebase','breathe','caremetric-emr','pennsync','caremetric-intel','caremetric-go');
  return jsonb_build_object('products',result,'loadedAt',now());
end;
$$;

create function hub.list_support_intake_tenants(p_product_id uuid,p_offset integer default 0,p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; total bigint;
begin
  perform hub.authorize_app_admin();
  if p_offset is null or p_offset<0 or p_offset>100000 or p_limit is null or p_limit<1 or p_limit>50 then
    raise exception 'Invalid page.';
  end if;
  if not exists(select 1 from hub.products where id=p_product_id and slug in ('carebase','breathe','caremetric-emr','pennsync','caremetric-intel','caremetric-go')) then
    raise exception 'Unknown eligible product.';
  end if;
  select count(*) into total from hub.tenant_products where product_id=p_product_id;
  select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.name,row_data."tenantId"),'[]'::jsonb) into result from (
    select t.id as "tenantId",t.name,t.status as "tenantStatus",tp.status as "accessStatus",
      coalesce(setting.enabled,false) as enabled,setting.updated_at as "updatedAt",
      private.support_usable_member_count(t.id,p_product_id) as "usableMemberCount",
      private.is_case_intake_enabled(t.id,p_product_id) and private.support_usable_member_count(t.id,p_product_id)>0 as ready
    from hub.tenant_products tp join hub.tenants t on t.id=tp.tenant_id
    left join private.case_intake_settings setting on setting.tenant_id=t.id and setting.product_id=p_product_id
    where tp.product_id=p_product_id order by t.name,t.id offset p_offset limit p_limit
  ) row_data;
  return jsonb_build_object('rows',result,'total',total,'offset',p_offset,'limit',p_limit);
end;
$$;

create function hub.set_support_intake(p_tenant_id uuid,p_product_id uuid,p_enabled boolean,p_reviewed boolean,p_expected_updated_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; setting private.case_intake_settings%rowtype; active boolean; revision timestamptz;
begin
  actor:=hub.authorize_app_command();
  if p_enabled is null or p_reviewed is distinct from true then raise exception 'Review the existing customer access first.'; end if;
  -- Serialize absent settings as well as existing ones, without creating access.
  select tp.status='active' and t.status='active' and p.status<>'retired' and p.support_enabled into active
  from hub.tenant_products tp join hub.tenants t on t.id=tp.tenant_id join hub.products p on p.id=tp.product_id
  where tp.tenant_id=p_tenant_id and tp.product_id=p_product_id
    and p.slug in ('carebase','breathe','caremetric-emr','pennsync','caremetric-intel','caremetric-go')
  for update of tp,t,p;
  if not found then raise exception 'Existing customer access required.'; end if;
  select * into setting from private.case_intake_settings where tenant_id=p_tenant_id and product_id=p_product_id for update;
  if setting.updated_at is distinct from p_expected_updated_at then raise exception 'Customer access changed. Refresh and review again.'; end if;
  if p_enabled and (not active or private.support_usable_member_count(p_tenant_id,p_product_id)=0) then
    raise exception 'Active access and a verified SMS customer account are required.';
  end if;
  insert into private.case_intake_settings(tenant_id,product_id,enabled,activated_at,activated_by)
    values(p_tenant_id,p_product_id,p_enabled,case when p_enabled then now() end,case when p_enabled then (actor->>'user_id')::uuid end)
  on conflict(tenant_id,product_id) do update set enabled=excluded.enabled,
    activated_at=case when excluded.enabled then now() else private.case_intake_settings.activated_at end,
    activated_by=case when excluded.enabled then excluded.activated_by else private.case_intake_settings.activated_by end
  returning updated_at into revision;
  -- Reuse the same support-owner check that actually gates case creation.
  if p_enabled and not private.is_case_intake_enabled(p_tenant_id,p_product_id) then
    raise exception 'An active verified support owner is required.';
  end if;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,tenant_id,product_id,changed_columns,metadata)
    values((actor->>'user_id')::uuid,'support.intake.set','tenant_product',p_tenant_id,p_tenant_id,p_product_id,array['enabled'],
      jsonb_build_object('enabled',p_enabled,'previousEnabled',coalesce(setting.enabled,false),'reviewed',true));
  return jsonb_build_object('enabled',p_enabled,'updatedAt',revision);
end;
$$;
revoke all on function hub.get_support_readiness() from public,anon;
revoke all on function hub.list_support_intake_tenants(uuid,integer,integer) from public,anon;
revoke all on function hub.set_support_intake(uuid,uuid,boolean,boolean,timestamptz) from public,anon;
grant execute on function hub.get_support_readiness() to authenticated;
grant execute on function hub.list_support_intake_tenants(uuid,integer,integer) to authenticated;
grant execute on function hub.set_support_intake(uuid,uuid,boolean,boolean,timestamptz) to authenticated;
