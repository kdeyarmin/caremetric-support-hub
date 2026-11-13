-- Website leads and the Sales Executive's reading of replies (AI workforce review 2026-11-12, findings P0 and P1). Reading a reply from
-- the sender's own words, colleagues at a business that answers (private.growth_reply_reading, 20261113150000) and a trial finding the
-- prospect it was (private.growth_ensure_customer, 20261113170000) are main's own reviewed fixes; this builds on them and replaces
-- neither:
--
-- 1. The Sales Executive's reading of a reply corrects what the keywords decided (private.growth_reply_disposition): interested,
--    a question or pricing is a positive reply; not now and not interested are what they say; an objection is recorded with its
--    playbook key; a request not to be contacted opts the sender out and suppresses the address.
-- 2. Website leads are followed up (private.growth_lead_capture, called by the Growth Manager when the owner turns on Settings ->
--    Customer growth -> "Follow up website leads by email"): a county report, contact, savings model or newsletter request from
--    Intel or CareBase becomes a qualified opportunity whose contact is the person who asked, permitted for email because they asked
--    for it, with the request as dated evidence. The existing drafting, approval and send checks apply; these are sales follow-ups,
--    not cold email. A trial sign-up records a signup on the business it came from at once, so no cold email crosses it.
-- 3. Contacts record where they came from: the person who asked (inbound), a contact-data service (enriched) or the owner's import
--    (imported), beside the owner's own and role addresses.
--
-- Nothing here sends.
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
 -- The person who asked becomes the contact until a conversation is under way, so the follow-up goes to them and not to a role address
 -- found earlier; the version bump retires drafts written to the earlier contact.
 on conflict (organization_id, product) do update set
   contact_id = case when o.stage in ('identified', 'researched', 'nurture', 'qualified', 'contacted') then excluded.contact_id
     else coalesce(o.contact_id, excluded.contact_id) end,
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

revoke all on function private.growth_free_mail(text) from public, anon, authenticated, service_role, hub_app_server;
revoke all on function private.growth_reply_disposition(uuid, text, text), private.growth_lead_capture(uuid) from public, anon, authenticated, service_role;
grant execute on function private.growth_reply_disposition(uuid, text, text), private.growth_lead_capture(uuid) to hub_app_server;
