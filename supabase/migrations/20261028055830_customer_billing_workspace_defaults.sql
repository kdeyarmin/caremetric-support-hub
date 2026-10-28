-- Optional product metadata and absent scheduled add-ons have concrete API defaults.
-- Preserve the installed context function, its authorization and its existing grants.
do $$
declare
 definition text;
 markers text[] := array[
  '''allows_addons'',p.entitlement_key=''core'' or p.metadata->>''allows_addons''=''true''',
  '''pending_addons'',to_jsonb(a.pending_addons)'
 ];
 replacements text[] := array[
  '''allows_addons'',p.entitlement_key=''core'' or coalesce(p.metadata->>''allows_addons''=''true'',false)',
  '''pending_addons'',coalesce(to_jsonb(a.pending_addons),''[]''::jsonb)'
 ];
 i integer;
begin
 definition := pg_get_functiondef('private.customer_billing_context(uuid)'::regprocedure);
 for i in 1..cardinality(markers) loop
  if (length(definition)-length(replace(definition,markers[i],'')))/length(markers[i]) <> 1 then
   raise exception 'Customer billing workspace default patch point % changed',i;
  end if;
  definition := replace(definition,markers[i],replacements[i]);
 end loop;
 execute definition;
end;
$$;
