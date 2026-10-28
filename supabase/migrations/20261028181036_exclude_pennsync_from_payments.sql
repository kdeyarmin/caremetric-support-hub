-- PennSync connects to support and training. It has no payment authority.
-- Keep existing training, support, identity and historical billing records.
do $patch$
declare definition text;anchor text;signature text;
begin
 definition:=pg_get_functiondef('private.customer_billing_context(uuid)'::regprocedure);
 anchor:='select livemode into live from private.billing_settings;';
 if position(anchor in definition)=0 then raise exception 'Review the installed customer billing context';end if;
 execute replace(definition,anchor,$replacement$
 if exists(select 1 from hub.products p where p.id=c.product_id and p.slug='pennsync') then
  raise exception 'PennSync does not accept payments' using errcode='42501';
 end if;
 select livemode into live from private.billing_settings;
 $replacement$);

 definition:=pg_get_functiondef('hub.prepare_self_service_operation(uuid,jsonb,boolean)'::regprocedure);
 anchor:='session:=(auth.jwt()->>''sms_session_id'')::uuid;';
 if position(anchor in definition)=0 then raise exception 'Review the installed native operation issuer';end if;
 execute replace(definition,anchor,$replacement$
 if p_operation->>'action'='billing.authorize' and exists(select 1 from hub.products p where p.id=c.product_id and p.slug='pennsync') then
  raise exception 'PennSync does not accept payments' using errcode='42501';
 end if;
 session:=(auth.jwt()->>'sms_session_id')::uuid;
 $replacement$);

 definition:=pg_get_functiondef('hub.billing_workspace()'::regprocedure);
 anchor:='p.slug<>''advisors''';
 if position(anchor in definition)=0 then raise exception 'Review the installed billing application list';end if;
 definition:=replace(definition,anchor,'p.slug not in (''advisors'',''pennsync'')');
 anchor:='from private.billing_app_keys k join hub.products p on p.id=k.product_id)';
 if position(anchor in definition)=0 then raise exception 'Review the installed billing credential list';end if;
 execute replace(definition,anchor,'from private.billing_app_keys k join hub.products p on p.id=k.product_id where p.slug<>''pennsync'')');

 -- A PennSync administrator alone cannot open the organization's payment
 -- portal or read shared invoices. Paid-app memberships retain their authority.
 foreach signature in array array['hub.my_billing()','hub.authorize_tenant_billing(uuid)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  anchor:='m.status=''active'' and m.revoked_at is null';
  if position(anchor in definition)=0 then raise exception 'Review the installed tenant payment authority: %',signature;end if;
  execute replace(definition,anchor,anchor||' and exists(select 1 from hub.products p where p.id=m.product_id and p.slug<>''pennsync'')');
 end loop;
end;
$patch$;

-- Keep the original maintained-guide revision intact; retire only its PennSync
-- billing publication. Search, AI retrieval and printable manuals share this scope.
delete from hub.content_publications cp using hub.content_items i,hub.products p
 where cp.item_id=i.id and cp.product_id=p.id and p.slug='pennsync' and i.content_key='self-service.subscriptions';
