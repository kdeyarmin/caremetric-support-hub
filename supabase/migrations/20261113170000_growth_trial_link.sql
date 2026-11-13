-- A customer who was a prospect keeps the prospect's growth record (review 2026-11-12, finding P0: a prospect who starts a trial
-- is not linked to its opportunity; billing creates a second organization).
--
-- private.growth_ensure_customer gave every billing tenant a new growth organization of its own ("customer-<tenant>.invalid") the
-- first time a trial, payment or product signal arrived. A prospect the Marketing Manager had found and written to stayed a
-- separate, uncustomered organization: its cold follow-ups kept going to a business already in a trial, and the trial was never
-- counted against the outreach that led to it.
--
-- Now, when a tenant has no growth organization yet, the address on its live billing customer (the address the application's
-- sign-up gave for the trial) is matched to a prospect before a new organization is made:
--
-- - the same address as a growth contact links that contact's organization, and that contact becomes the product
--   opportunity's contact;
-- - otherwise the same business domain as a prospect organization links it (never for a personal mail domain). The person who
--   signed up joins it as a contact for review (eligibility 'review': nothing is sent to them until the owner or the contact
--   finder permits it) and becomes the product opportunity's contact, so customer email never goes to the person we
--   cold-emailed on the strength of a colleague's sign-up.
--
-- Only an organization that is not a customer already and not internal is linked. Linking sets its tenant, so the send claim
-- refuses cold email to it from then on, and unsent marketing drafts there are cancelled. The trial or payment then lands on the
-- prospect's own opportunity. Each link is audited as growth.customer_linked with the tenant, the product and whether the
-- address or the domain matched, never the address itself.
--
-- The sign-up address is the applicant's own claim (the application does not confirm it before the trial starts), so a link
-- only does what is safe on a claim: it stops prospecting and credits the trial; it sends nothing to anyone new. A tenant that
-- already has a growth organization is left as it is. Test-mode billing customers never link.
--
-- A linked customer keeps the prospect's real domain, which discovery can find again. private.growth_discover is replaced with the
-- same signature (grants are kept) and the same body, except that a found business that is already a customer or internal adds no
-- opportunity and no evidence: before, a customer's placeholder domain could never be found, and a customer's organization is not
-- prospected for the other product either (the claim refuses cold email to it).
--
-- No table, grant or declared feature changes; production had no tenant whose address matched a prospect when this was written.
set local lock_timeout = '10s';

create or replace function private.growth_ensure_customer(p_tenant uuid,p_product text) returns uuid
language plpgsql security definer set search_path='' as $$
declare org uuid; v_email text; v_contact uuid; v_match text;
 -- The same personal mail domains private.growth_inquiry never links to a business.
 v_personal constant text[]:=array['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','yahoo.com','ymail.com','icloud.com','me.com','mac.com','aol.com','comcast.net','verizon.net','att.net','sbcglobal.net','protonmail.com','proton.me']; begin
 if p_product not in ('carebase','caremetric-intel') or not exists(select 1 from hub.tenants where id=p_tenant) then
  raise exception 'Unknown growth customer' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 select id into org from private.growth_organizations where tenant_id=p_tenant;
 if org is null then
  -- The prospect this customer was: the sign-up address, then its business domain.
  select lower(btrim(email)) into v_email from private.billing_customers
  where tenant_id=p_tenant and livemode and not deleted and lower(btrim(email)) ~ '^[^ @]+@[^ @]+\.[^ @]+$';
  if v_email is not null then
   select c.organization_id,c.id into org,v_contact from private.growth_contacts c join private.growth_organizations g on g.id=c.organization_id
   where c.email=v_email and g.tenant_id is null and not g.internal;
   if org is not null then
    v_match:='contact';
   elsif split_part(v_email,'@',2)<>all(v_personal) then
    select id into org from private.growth_organizations where domain=split_part(v_email,'@',2) and tenant_id is null and not internal;
    if org is not null then
     v_match:='domain';
     insert into private.growth_contacts(organization_id,email) values(org,v_email) on conflict(email) do nothing;
     select id into v_contact from private.growth_contacts where email=v_email and organization_id=org;
    end if;
   end if;
   if org is not null then
    update private.growth_organizations set tenant_id=p_tenant where id=org;
    -- The claim already refuses cold email to a customer's organization; withdraw what is queued there.
    update private.growth_messages m set status='cancelled' from private.growth_opportunities o
    where m.opportunity_id=o.id and o.organization_id=org and m.purpose='marketing' and m.status in ('draft','proposed');
    insert into private.audit_events(action,entity_type,entity_id,tenant_id,product_id,metadata)
    values('growth.customer_linked','growth_organization',org,p_tenant,(select id from hub.products where slug=p_product),
     jsonb_build_object('product',p_product,'match',v_match));
   end if;
  end if;
 end if;
 if org is null then
  insert into private.growth_organizations(name,domain,tenant_id)
  select name,'customer-'||p_tenant::text||'.invalid',id from hub.tenants where id=p_tenant
  returning id into org;
 end if;
 -- A linked customer whose first signal is a heartbeat must never enter the cold-prospect pipeline.
 insert into private.growth_opportunities as o(organization_id,product,stage,owner_agent,next_action)
 values(org,p_product,'nurture','account_manager','Wait for verified product activity')
 on conflict(organization_id,product) do update set owner_agent='account_manager',
  stage=case when o.stage in ('identified','researched','qualified','contacted','engaged','demo') then 'nurture' else o.stage end,
  version=o.version+1,updated_at=now()
 where o.owner_agent='marketing_manager';
 -- A linked prospect's customer email goes to the person who signed up, never to whoever was cold-emailed before.
 if v_contact is not null then
  update private.growth_opportunities set contact_id=v_contact,version=version+1,updated_at=now()
  where organization_id=org and product=p_product and contact_id is distinct from v_contact;
 end if;
 -- A first heartbeat can establish customer context before a trial signal; stale cold drafts must not survive that handoff.
 update private.growth_messages m set status='cancelled' from private.growth_opportunities o
 where m.opportunity_id=o.id and o.organization_id=org and o.product=p_product and m.status in ('draft','proposed') and m.opportunity_version<>o.version;
 return org;
end; $$;
revoke all on function private.growth_ensure_customer(uuid,text) from public,anon,authenticated,service_role,hub_app_server;

-- The same as 20261105150000_growth_autonomy.sql, except that a customer's or internal organization is not prospected.
create or replace function private.growth_discover(p_product text,p_rows jsonb) returns integer
language plpgsql security definer set search_path='' as $$ declare r jsonb; v_org uuid; v_opp uuid; v_n integer:=0; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 if p_product not in ('carebase','caremetric-intel') or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>10 then raise exception 'Invalid discovery' using errcode='22023'; end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  insert into private.growth_organizations(name,domain,discovered_at) values(left(r->>'name',200),r->>'domain',now()) on conflict(domain) do nothing;
  select id into v_org from private.growth_organizations where domain=r->>'domain' and tenant_id is null and not internal;
  continue when v_org is null;
  insert into private.growth_opportunities(organization_id,product) values(v_org,p_product) on conflict do nothing;
  select id into v_opp from private.growth_opportunities where organization_id=v_org and product=p_product;
  insert into private.growth_evidence(opportunity_id,source_url,claim,confidence,observed_at) values(v_opp,r->>'url',left(r->>'claim',4000),'low',now()) on conflict do nothing;
  v_n:=v_n+1;
 end loop;
 return v_n;
end; $$;

do $$
declare r text;
begin
  if not exists (select 1 from pg_proc where oid = 'private.growth_discover(text,jsonb)'::regprocedure and prosecdef
                   and proconfig @> array['search_path=""'] and prosrc like '%require_hub_app_server%' and prosrc like '%tenant_id is null and not internal%')
     or not has_function_privilege('hub_app_server', 'private.growth_discover(text,jsonb)', 'execute')
     or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) x where has_function_privilege(x, 'private.growth_discover(text,jsonb)', 'execute')) then
    raise exception 'Discovery would prospect a customer' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_proc where oid = 'private.growth_ensure_customer(uuid,text)'::regprocedure and prosecdef
                   and proconfig @> array['search_path=""'] and prosrc like '%billing_customers%' and prosrc like '%growth.customer_linked%') then
    raise exception 'Customers are not linked to the prospect they were' using errcode = '55000';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_function_privilege(r, 'private.growth_ensure_customer(uuid,text)', 'execute') then
      raise exception 'Growth customer linking exposed to %', r using errcode = '55000';
    end if;
  end loop;
end $$;
