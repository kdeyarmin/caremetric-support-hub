-- Replies, trials and website leads that the growth pipeline lost (AI workforce review 2026-11-12, findings P0 and P1).
--
-- 1. Replies are read from what the sender wrote (private.growth_reply_text): quoted lines and everything under a reply header ("On
--    … wrote:", "Original Message", "From: … Sent:") or under the Hub's own footer are left out. A quoted footer or a quoted pitch
--    no longer opts a prospect out or reads as interest. When nothing is left, the text without quoted lines is read.
-- 2. Negative answers are recognized before positive ones ("not really interested" was read as "interested"), with more of the ways
--    people say no ("no longer interested", "not a fit", "we are all set") and not now ("maybe later", "next year", "too busy").
-- 3. A reply from another mailbox at a business already in growth (same business domain, never a free mail service) belongs to that
--    business: it is recorded, stops queued outreach to every contact there, and moves the stage. Before, it was ignored unless its
--    text happened to say demo, pricing or interested, so touches 2 and 3 kept going to a business that had answered.
-- 4. The Sales Executive's reading of a reply corrects what the keywords decided (private.growth_reply_disposition): interested,
--    a question or pricing is a positive reply; not now and not interested are what they say; an objection is recorded with its
--    playbook key; a request not to be contacted opts the sender out and suppresses the address.
-- 5. A trial no longer creates a second organization when the prospect is already in growth (private.growth_ensure_customer): the
--    billing customer's email is matched to a growth contact, then to the one business on that email's domain. The prospect's
--    organization takes the tenant, which already stops cold email to it, and its history is the customer's.
-- 6. Website leads are followed up (private.growth_lead_capture, called by the Growth Manager when the owner turns on Settings ->
--    Customer growth -> "Follow up website leads by email"): a county report, contact, savings model or newsletter request from
--    Intel or CareBase becomes a qualified opportunity whose contact is the person who asked, permitted for email because they asked
--    for it, with the request as dated evidence. The existing drafting, approval and send checks apply; these are sales follow-ups,
--    not cold email. A trial sign-up records a signup on the business it came from at once, so no cold email crosses it.
--
-- The fail-safe trigger (20261104210000) reads opt-outs the same way. Nothing here sends.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.inbound_followup', 'flag')
on conflict (key) do nothing;

-- Contacts may now be the person who asked (inbound), found by a contact-data service (enriched) or imported by the owner (imported).
do $$ declare v_name text; begin
  select conname into v_name from pg_constraint where conrelid = 'private.growth_contacts'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%source_kind = ANY%' and pg_get_constraintdef(oid) like '%''owner''%' and conname <> 'growth_contacts_role_address_check';
  if v_name is not null then execute format('alter table private.growth_contacts drop constraint %I', v_name); end if;
end $$;
alter table private.growth_contacts add constraint growth_contacts_source_kind_check
  check (source_kind in ('owner', 'role_address', 'inbound', 'enriched', 'imported'));

-- Mail services whose domain says nothing about the business a person works for.
create function private.growth_free_mail(p_domain text) returns boolean
language sql immutable set search_path = '' as $$
  select lower(coalesce(p_domain, '')) in ('gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com',
    'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net',
    'cox.net', 'charter.net', 'protonmail.com', 'proton.me', 'mail.com', 'gmx.com', 'zoho.com', 'fastmail.com', 'hey.com')
$$;

-- What the sender wrote, without what they quoted.
create function private.growth_reply_text(p_body text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := replace(coalesce(p_body, ''), chr(13), ''); v_head text;
begin
 v := regexp_replace(v, '(^|\n)[ \t]*>[^\n]*', '\1', 'g');
 v_head := substring(v from '^(.*?)(\n[^\n]{0,250}[Ww]rote:[ \t]*(\n|$)|\n[ \t]*-{2,}[ \t]*(Original|Forwarded) [Mm]essage|\n[ \t]*From:[^\n]*\n[ \t]*(Sent|Date):|Opt out of these emails)');
 if v_head is not null and btrim(v_head, ' ' || chr(9) || chr(10)) <> '' then v := v_head; end if;
 return btrim(v, ' ' || chr(9) || chr(10));
end; $$;

-- How a reply's own words read, negatives first. 'reply' when nothing is clear.
create function private.growth_reply_kind(p_text text) returns text
language sql immutable set search_path = '' as $$
 select case
  when p_text ~* '\m(cancel (my|our|the) (account|subscription|service)|close my account|want to cancel)\M' then 'cancel_requested'
  when p_text ~* '\m(not (really |currently |that |very |at all )?interested|no longer interested|isn''t (something|a fit)|is not (something|a fit)|no thanks|no thank you|not a (good )?fit|we are all set|we''re all set|all set for now|not for us|pass on this|please remove|remove me|unsubscribe|do not contact|stop emailing)\M' then 'negative_reply'
  when p_text ~* '\m(not now|not right now|not at this time|maybe later|later this year|next (quarter|year|month|spring|summer|fall)|contact me later|reach out (later|again)|check back|circle back|after the (holidays|survey|new year)|too busy)\M' then 'not_now'
  when p_text ~* '\m(interested|tell me more|sounds (good|great|interesting)|send (me )?(more|the link|info|information)|sign(ing)? up|start (a|the) (free )?trial|book a demo|schedule a demo|how much|pricing|what does it cost)\M' then 'positive_reply'
  else 'reply' end
$$;

create or replace function private.growth_inquiry(p_id uuid) returns integer
language plpgsql security definer set search_path='' as $$
declare c private.communications%rowtype; m private.communication_messages%rowtype; v_product text; v_org uuid; v_contact uuid; v_opp uuid;
 v_message uuid; v_text text; v_reply text; v_n integer:=0; v_email text; v_domain text; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 select * into m from private.communication_messages where id=p_id and direction='inbound';
 -- Only email webhook ingestion binds this message to its sender. Chat and form addresses are visitor claims.
 -- Check the message, not the thread: a verified email can join a thread originally opened through a public form.
 if not found or m.provider_message_id is null or m.provider_message_id not like 'email:%' then return 0; end if;
 select * into c from private.communications where id=m.communication_id;
 if not found or c.contact_email is null then return 0; end if;
 v_email:=lower(btrim(c.contact_email)); v_domain:=split_part(v_email,'@',2);
 select id,organization_id into v_contact,v_org from private.growth_contacts where email=v_email;
 select slug into v_product from hub.products where id=c.product_id;
 v_message:=m.id; v_text:=private.growth_reply_text(m.body);
 -- Another mailbox at a business already in growth: its reply is that business's.
 if v_org is null and not private.growth_free_mail(v_domain) then
  select id into v_org from private.growth_organizations where domain=v_domain;
  if v_org is not null then
   insert into private.growth_contacts(organization_id,email,name) values(v_org,v_email,left(coalesce(c.contact_name,''),200)) on conflict(email) do nothing;
   select id into v_contact from private.growth_contacts where email=v_email;
  end if;
 end if;
 if v_org is null and v_product in ('carebase','caremetric-intel') and (c.inquiry_type='sales' or v_text ~* '\m(demo|pricing|purchase|interested|buy)\M') and not private.growth_free_mail(v_domain) then
  insert into private.growth_organizations(name,domain) values(coalesce(nullif(c.organization,''),'Inbound organization'),v_domain) on conflict(domain) do nothing;
  select id into v_org from private.growth_organizations where domain=v_domain;
  insert into private.growth_contacts(organization_id,email,name) values(v_org,v_email,coalesce(c.contact_name,'')) on conflict(email) do nothing;
  select id into v_contact from private.growth_contacts where email=v_email;
  insert into private.growth_opportunities(organization_id,product,contact_id,stage,next_action) values(v_org,v_product,v_contact,'engaged','Respond to inbound inquiry') on conflict do nothing;
 end if;
 if v_org is null then return 0; end if;
 v_reply:=private.growth_reply_kind(v_text);
 if v_text ~* '\m(unsubscribe|do not contact|stop emailing|remove me)\M' then
  update private.growth_contacts set eligibility='opted_out',version=version+1 where id=v_contact;
  insert into private.email_suppressions(email_hash) values(encode(extensions.digest(v_email,'sha256'),'hex')) on conflict do nothing;
 end if;
 -- Any reply stops queued outreach to every contact at the business, across both products. No conversation text is copied.
 update private.growth_messages set status='cancelled' where status in ('draft','proposed')
  and contact_id in (select id from private.growth_contacts where organization_id=v_org);
 for v_opp in select id from private.growth_opportunities where organization_id=v_org loop
  insert into private.customer_activity_events(product,organization_id,event_key,kind,occurred_at,facts)
  select product,organization_id,'inquiry:'||v_message::text,v_reply,m.created_at,jsonb_build_object('communicationId',c.id) from private.growth_opportunities where id=v_opp on conflict do nothing;
  if found then
   update private.growth_opportunities set owner_agent=case when v_reply='cancel_requested' then 'account_manager' else owner_agent end,stage=case when v_reply in ('not_now','negative_reply') and stage in ('identified','researched','qualified','contacted','engaged') then 'nurture' when stage in ('identified','researched','qualified','contacted') then 'engaged' else stage end,next_action='Review the customer reply in Communications',next_at=now(),version=version+1,updated_at=now() where id=v_opp;
   perform private.growth_plan(v_opp,jsonb_build_object('key','reply:'||v_message::text,'kind',case when v_reply='cancel_requested' then 'recovery' else 'reply' end,'action',case when v_reply='cancel_requested' then 'Review cancellation concerns in Communications and agree a recovery plan.' else 'Review the customer reply in Communications and agree a next step.' end,'success','The customer question is resolved and the next step recorded.','owner',(select owner_agent from private.growth_opportunities where id=v_opp),'dueAt',now()));
   v_n:=v_n+1;
  end if;
 end loop;
 return v_n;
end; $$;

-- The fail-safe reads an opt-out from the sender's own words too, so a quoted footer never opts anyone out.
create or replace function private.growth_inbound_trigger() returns trigger language plpgsql security definer
set search_path='' set lock_timeout='3s' as $$
declare v_state text; v_fallback text; v_contact uuid; v_email text;
begin
 if new.direction='inbound' and session_user='hub_app_server' and new.provider_message_id like 'email:%' then
  begin
   perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
  exception when others then
   v_state:=sqlstate;
  end;
  if v_state is null then
   begin
    perform private.growth_inquiry(new.id);
   exception when others then
    v_state:=sqlstate;
   end;
  end if;
  if v_state is not null then
   begin
    select g.id,g.email into v_contact,v_email from private.communications c join private.growth_contacts g on g.email=lower(btrim(c.contact_email))
    where c.id=new.communication_id;
    if v_contact is not null then
     if private.growth_reply_text(new.body) ~* '\m(unsubscribe|do not contact|stop emailing|remove me)\M' then
      update private.growth_contacts set eligibility='opted_out',version=version+1 where id=v_contact;
      insert into private.email_suppressions(email_hash) values(encode(extensions.digest(v_email,'sha256'),'hex')) on conflict do nothing;
     end if;
     update private.growth_messages set status='cancelled' where contact_id=v_contact and status in ('draft','proposed');
    end if;
   exception when others then
    v_fallback:=sqlstate;
   end;
   begin
    insert into private.audit_events(action,entity_type,entity_id,metadata)
    values('growth.inquiry_failed','communication_message',new.id,
     jsonb_strip_nulls(jsonb_build_object('communicationId',new.communication_id,'sqlstate',v_state,'fallbackSqlstate',v_fallback)));
   exception when others then
    raise warning 'Growth capture skipped an inbound email (%, %)', v_state, coalesce(v_fallback,'-');
   end;
  end if;
 end if;
 return new;
end; $$;
revoke all on function private.growth_inbound_trigger() from public,anon,authenticated,service_role,hub_app_server;

-- Server (the Sales Executive): its reading of one inbound message, which corrects the keyword reading of the same message.
create function private.growth_reply_disposition(p_message uuid, p_intent text, p_objection text default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_kind text; v_n integer; v_email text; v_contact uuid; v_org uuid; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_intent is null or p_intent !~ '^[a-z_]{1,30}$' or (p_objection is not null and p_objection !~ '^[a-z_]{1,30}$') then
  raise exception 'Invalid disposition' using errcode = '22023';
 end if;
 v_kind := case when p_intent in ('interested', 'question', 'pricing') then 'positive_reply' when p_intent = 'not_now' then 'not_now'
   when p_intent in ('not_interested', 'unsubscribe') then 'negative_reply' else 'reply' end;
 update private.customer_activity_events set kind = v_kind,
   facts = facts || jsonb_strip_nulls(jsonb_build_object('readBy', 'sales_executive', 'intent', p_intent, 'objection', p_objection))
  where event_key = 'inquiry:' || p_message::text and kind in ('reply', 'positive_reply', 'negative_reply', 'not_now');
 get diagnostics v_n = row_count;
 if v_n = 0 then return 0; end if;
 select organization_id into v_org from private.customer_activity_events where event_key = 'inquiry:' || p_message::text limit 1;
 if v_kind in ('not_now', 'negative_reply') then
  update private.growth_opportunities set stage = 'nurture', version = version + 1, updated_at = now()
   where organization_id = v_org and stage in ('identified', 'researched', 'qualified', 'contacted', 'engaged') and owner_agent = 'marketing_manager';
 end if;
 if p_intent = 'unsubscribe' then
  select lower(btrim(c.contact_email)) into v_email from private.communication_messages m join private.communications c on c.id = m.communication_id
   where m.id = p_message;
  select id into v_contact from private.growth_contacts where email = v_email;
  if v_contact is not null then update private.growth_contacts set eligibility = 'opted_out', version = version + 1 where id = v_contact; end if;
  if v_email ~ '@' then insert into private.email_suppressions(email_hash) values (encode(extensions.digest(v_email, 'sha256'), 'hex')) on conflict do nothing; end if;
 end if;
 return v_n;
end; $$;

-- A trial or a payment for a tenant: the prospect it was, when growth knows it, takes the tenant; otherwise a customer record.
create or replace function private.growth_ensure_customer(p_tenant uuid,p_product text) returns uuid
language plpgsql security definer set search_path='' as $$
declare org uuid; v_email text; v_domain text; begin
 if p_product not in ('carebase','caremetric-intel') or not exists(select 1 from hub.tenants where id=p_tenant) then
  raise exception 'Unknown growth customer' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 select id into org from private.growth_organizations where tenant_id=p_tenant;
 if org is null then
  -- The billing customer's email (the person who started the trial): a growth contact first, then the one business on its domain.
  select lower(btrim(email)) into v_email from private.billing_customers where tenant_id=p_tenant and not deleted;
  if v_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
   v_domain:=split_part(v_email,'@',2);
   select g.id into org from private.growth_contacts c join private.growth_organizations g on g.id=c.organization_id
    where c.email=v_email and g.tenant_id is null and not g.internal limit 1;
   if org is null and not private.growth_free_mail(v_domain) then
    select id into org from private.growth_organizations where domain=v_domain and tenant_id is null and not internal;
   end if;
   if org is not null then
    update private.growth_organizations set tenant_id=p_tenant where id=org and tenant_id is null;
    insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(null,'growth.prospect_became_customer','growth',org,jsonb_build_object('tenant',p_tenant,'product',p_product,'matchedBy',
      case when exists(select 1 from private.growth_contacts where email=v_email and organization_id=org) then 'contact' else 'domain' end));
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
 -- A first heartbeat can establish customer context before a trial signal; stale cold drafts must not survive that handoff.
 update private.growth_messages m set status='cancelled' from private.growth_opportunities o
 where m.opportunity_id=o.id and o.organization_id=org and o.product=p_product and m.status in ('draft','proposed') and m.opportunity_version<>o.version;
 return org;
end; $$;
revoke all on function private.growth_ensure_customer(uuid,text) from public,anon,authenticated,service_role,hub_app_server;

-- Server (the Growth Manager): one website lead into growth. Returns what it did, never the address or the person's details.
create function private.growth_lead_capture(p_lead uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l private.leads%rowtype; v_product text; v_domain text; v_org uuid; g private.growth_organizations%rowtype; v_contact uuid; v_opp uuid;
 v_place text; v_claim text; v_url text; v_origin text; v_what text; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 select * into l from private.leads where id = p_lead;
 if not found then raise exception 'Unknown lead' using errcode = '22023'; end if;
 if l.test or l.status = 'spam' then return jsonb_build_object('captured', false, 'reason', 'not_a_lead'); end if;
 v_product := case l.source when 'intel' then 'caremetric-intel' when 'carebase' then 'carebase' end;
 if v_product is null then return jsonb_build_object('captured', false, 'reason', 'product'); end if;
 if exists (select 1 from private.email_suppressions where email_hash = encode(extensions.digest(l.contact_email, 'sha256'), 'hex')) then
  return jsonb_build_object('captured', false, 'reason', 'suppressed');
 end if;
 v_domain := split_part(l.contact_email, '@', 2);
 select organization_id, id into v_org, v_contact from private.growth_contacts where email = l.contact_email;
 if v_org is null and not private.growth_free_mail(v_domain) then select id into v_org from private.growth_organizations where domain = v_domain; end if;
 if l.kind = 'trial_signup' then
  -- The business signed up for a trial: no cold email may cross it while billing catches up.
  if v_org is null then return jsonb_build_object('captured', false, 'reason', 'no_prospect'); end if;
  insert into private.customer_activity_events(product, organization_id, event_key, kind, occurred_at, facts)
  values (v_product, v_org, 'lead:' || l.id::text, 'signup', l.occurred_at, jsonb_build_object('lead', l.kind)) on conflict do nothing;
  update private.growth_messages set status = 'cancelled' where status in ('draft', 'proposed') and purpose = 'marketing'
   and contact_id in (select id from private.growth_contacts where organization_id = v_org);
  return jsonb_build_object('captured', true, 'kind', 'signup');
 end if;
 if l.kind not in ('county_report', 'savings_model', 'contact', 'newsletter') then return jsonb_build_object('captured', false, 'reason', 'kind'); end if;
 if v_org is null then
  insert into private.growth_organizations(name, domain)
  values (left(coalesce(l.organization, initcap(split_part(v_domain, '.', 1)), 'Website lead'), 200),
          case when private.growth_free_mail(v_domain) then 'lead-' || l.id::text || '.invalid' else v_domain end)
  on conflict (domain) do nothing;
  select id into v_org from private.growth_organizations
   where domain = case when private.growth_free_mail(v_domain) then 'lead-' || l.id::text || '.invalid' else v_domain end;
 end if;
 select * into g from private.growth_organizations where id = v_org;
 if g.internal or g.tenant_id is not null then return jsonb_build_object('captured', false, 'reason', 'customer'); end if;
 if v_contact is null then
  insert into private.growth_contacts(organization_id, email, name, role, eligibility, verified_at, source_url, source_kind)
  values (v_org, l.contact_email, coalesce(l.contact_name, ''), coalesce(l.role, ''), 'permitted', l.received_at, null, 'inbound')
  on conflict (email) do nothing;
  select id into v_contact from private.growth_contacts where email = l.contact_email;
 elsif (select eligibility from private.growth_contacts where id = v_contact) = 'review' then
  -- They asked us directly: their address may be written to about what they asked for.
  update private.growth_contacts set eligibility = 'permitted', verified_at = l.received_at, version = version + 1 where id = v_contact;
 end if;
 if (select eligibility from private.growth_contacts where id = v_contact) <> 'permitted' then
  return jsonb_build_object('captured', false, 'reason', 'opted_out');
 end if;
 v_place := nullif(concat_ws(', ', nullif(l.details ->> 'county', ''), nullif(l.details ->> 'state', '')), '');
 v_what := case l.kind when 'county_report' then 'the free county report' || coalesce(' for ' || v_place, '')
   when 'savings_model' then 'the savings model' when 'newsletter' then 'the newsletter' else 'information through the contact form' end;
 v_origin := case v_product when 'caremetric-intel' then 'https://www.caremetricintel.com' else 'https://cmcarebase.com' end;
 v_url := v_origin || coalesce(l.landing_path, '/');
 v_claim := left('Asked for ' || v_what || ' on ' || to_char(l.occurred_at at time zone 'America/New_York', 'FMMonth FMDD, YYYY')
   || ' through the ' || case v_product when 'caremetric-intel' then 'CareMetric Intel' else 'CareBase' end || ' website.', 1000);
 insert into private.growth_opportunities as o(organization_id, product, contact_id, stage, next_action, memory)
 values (v_org, v_product, v_contact, 'qualified', 'Follow up the website request', jsonb_build_object('lead', jsonb_strip_nulls(jsonb_build_object(
   'kind', l.kind, 'place', v_place, 'at', l.occurred_at))))
 on conflict (organization_id, product) do update set
   contact_id = coalesce(o.contact_id, excluded.contact_id),
   stage = case when o.stage in ('identified', 'researched', 'nurture') then 'qualified' else o.stage end,
   memory = o.memory || excluded.memory, next_action = case when o.stage in ('identified', 'researched', 'nurture') then excluded.next_action else o.next_action end,
   next_at = now(), version = o.version + 1, updated_at = now()
  where o.owner_agent = 'marketing_manager';
 select id into v_opp from private.growth_opportunities where organization_id = v_org and product = v_product;
 insert into private.growth_evidence(opportunity_id, source_url, claim, confidence, observed_at)
 values (v_opp, v_url, v_claim, 'high', l.occurred_at) on conflict (opportunity_id, source_url, claim) do nothing;
 insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
 values (null, 'growth.lead_captured', 'growth', v_org, jsonb_build_object('lead', l.id, 'kind', l.kind, 'product', v_product));
 return jsonb_build_object('captured', true, 'kind', l.kind, 'opportunityId', v_opp);
end; $$;

revoke all on function private.growth_free_mail(text), private.growth_reply_text(text), private.growth_reply_kind(text) from public, anon, authenticated, service_role, hub_app_server;
revoke all on function private.growth_reply_disposition(uuid, text, text), private.growth_lead_capture(uuid) from public, anon, authenticated, service_role;
grant execute on function private.growth_reply_disposition(uuid, text, text), private.growth_lead_capture(uuid) to hub_app_server;
