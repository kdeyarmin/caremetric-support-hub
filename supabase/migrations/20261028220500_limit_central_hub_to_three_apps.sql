-- Only CareBase, Breathe and Intel participate in the centralized Hub.
-- Keep product identities, memberships, tickets, learning and billing history.
set local lock_timeout='10s';

create function private.hub_application_enabled(p_product uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from hub.products p where p.id=p_product
  and p.slug in ('carebase','breathe','caremetric-intel') and p.status<>'retired' and p.support_enabled);
$$;
revoke all on function private.hub_application_enabled(uuid) from public,anon,authenticated,service_role;

-- Disconnection closes new intake, not a current member's historical cases.
-- Preserve the existing tenant, membership, suspension and verification checks.
do $history$
declare definition text;
begin
 definition:=pg_get_functiondef('private.is_active_member(uuid,uuid)'::regprocedure);
 definition:=replace(definition,'private.is_active_member(','private.is_historical_member(');
 definition:=replace(definition,'and product.status <> ''retired''','');
 definition:=replace(definition,'and product.support_enabled','');
 execute definition;
 definition:=pg_get_functiondef('private.can_view_case(uuid,uuid,uuid,uuid)'::regprocedure);
 if position('private.is_active_member(p_tenant_id,p_product_id)' in definition)=0 then raise exception 'Review historical case membership';end if;
 execute replace(definition,'private.is_active_member(p_tenant_id,p_product_id)','private.is_historical_member(p_tenant_id,p_product_id)');
end;
$history$;
revoke all on function private.is_historical_member(uuid,uuid) from public,anon,authenticated,service_role;

update hub.products set status='retired',support_enabled=false
 where slug not in ('carebase','breathe','caremetric-intel');
update private.billing_app_keys k set revoked_at=coalesce(k.revoked_at,now())
 from hub.products p where p.id=k.product_id and p.slug not in ('carebase','breathe','caremetric-intel');
update private.case_intake_settings s set enabled=false
 from hub.products p where p.id=s.product_id and p.slug not in ('carebase','breathe','caremetric-intel');
update private.self_service_connections c set revoked_at=coalesce(c.revoked_at,now())
 from hub.products p where p.id=c.product_id and p.slug not in ('carebase','breathe','caremetric-intel');
update private.self_service_handoffs h set expires_at=least(h.expires_at,now())
 from hub.products p where p.id=h.product_id and p.slug not in ('carebase','breathe','caremetric-intel');
update private.self_service_operations o set expires_at=least(o.expires_at,now()),result_state=coalesce(o.result_state,'refused')
 from private.self_service_connections c join hub.products p on p.id=c.product_id
 where o.connection_id=c.id and p.slug not in ('carebase','breathe','caremetric-intel') and o.consumed_at is null;

-- Preserve installed session, identity and facility checks; add the app boundary.
do $patch$
declare definition text; signature text; anchor text;
begin
 definition:=pg_get_functiondef('private.issue_self_service_connection(uuid,jsonb,text)'::regprocedure);
 anchor:='perform private.require_hub_app_server();';
 if position(anchor in definition)=0 then raise exception 'Review native connection issuer';end if;
 execute replace(definition,anchor,anchor||$guard$
 if not private.hub_application_enabled(p_product) then raise exception 'Application disconnected' using errcode='42501';end if;
 $guard$);

 definition:=pg_get_functiondef('hub.accept_self_service_connection(text)'::regprocedure);
 anchor:='issuer:=private.billing_issuer(proof.product_id);';
 if position(anchor in definition)=0 then raise exception 'Review native connection acceptance';end if;
 execute replace(definition,anchor,$guard$
 if not private.hub_application_enabled(proof.product_id) then raise exception 'Application disconnected' using errcode='42501';end if;
 $guard$||anchor);

 foreach signature in array array['hub.prepare_self_service_operation(uuid,jsonb,boolean)','hub.issue_self_service_operation(uuid,text,boolean)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  anchor:='not private.is_active_member(c.tenant_id,c.product_id)';
  if position(anchor in definition)=0 then raise exception 'Review native operation authorization: %',signature;end if;
  execute replace(definition,anchor,'(not private.is_active_member(c.tenant_id,c.product_id) or not private.hub_application_enabled(c.product_id))');
 end loop;

 definition:=pg_get_functiondef('hub.self_service_workspace()'::regprocedure);
 anchor:='c.user_id=auth.uid() and c.revoked_at is null';
 if position(anchor in definition)=0 then raise exception 'Review native workspace';end if;
 execute replace(definition,anchor,anchor||' and private.hub_application_enabled(c.product_id)');

 definition:=pg_get_functiondef('private.consume_self_service_operation(text,text)'::regprocedure);
 anchor:='p.slug=p_app';
 if position(anchor in definition)=0 then raise exception 'Review native capability redemption';end if;
 execute replace(definition,anchor,anchor||' and private.hub_application_enabled(p.id)');

 definition:=pg_get_functiondef('private.billing_authenticate_app(text)'::regprocedure);
 anchor:='p.status<>''retired''';
 if position(anchor in definition)=0 then raise exception 'Review application authentication';end if;
 execute replace(definition,anchor,anchor||' and private.hub_application_enabled(p.id)');

 definition:=pg_get_functiondef('private.customer_billing_context(uuid)'::regprocedure);
 anchor:='select livemode into live from private.billing_settings;';
 if position(anchor in definition)=0 then raise exception 'Review customer billing scope';end if;
 execute replace(definition,anchor,$guard$
 if not private.hub_application_enabled(c.product_id) then raise exception 'Application disconnected' using errcode='42501';end if;
 $guard$||anchor);

 foreach signature in array array['hub.my_billing()','hub.authorize_tenant_billing(uuid)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  anchor:='m.status=''active'' and m.revoked_at is null';
  if position(anchor in definition)=0 then raise exception 'Review organization billing authority: %',signature;end if;
  execute replace(definition,anchor,anchor||' and private.hub_application_enabled(m.product_id)');
 end loop;
end;
$patch$;
