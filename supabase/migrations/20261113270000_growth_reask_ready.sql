-- Re-asks that can be sent (review of the AI workforce build-out, 2026-11-13).
--
-- private.growth_reengage (20261113172000) moves an opportunity back to qualified for one re-ask months after its last message. By
-- then two of the send claim's rules could not pass: the contact must have been verified in the last 90 days, and the message must
-- cite evidence observed in the last 30 days. Nothing renewed either for a qualified opportunity: the contact finder searched only
-- businesses with no contact, research reads only identified and researched prospects, and a home page summary seen again kept its
-- first date. Every re-ask was drafted and then cancelled by the claim.
--
-- 1. private.growth_contact_candidates (same signature and grants) also offers the contact finder a business with a re-ask not yet
--    sent whose public role address was last seen more than 80 days ago, or that has no evidence for outreach observed in the last
--    21 days, at most once a week. Businesses with no contact still come first. Finding the same address again re-verifies it
--    (private.growth_record_contact, unchanged), and the home page summary read with it becomes dated evidence.
-- 2. private.growth_discover (same signature and grants) dates evidence it sees again: for an opportunity past research (qualified
--    or contacted) the same page and claim found again was observed now. Before qualification a duplicate still changes nothing,
--    so it never buys a new model assessment. Customers' and internal organizations are still never prospected (20261113170000).
-- 3. private.growth_reengage (same signature and grants) starts a re-ask only when its address can be current when it is sent: a
--    public role address the contact finder can see again, or any other address verified in the last 80 days. A person's address
--    (a website lead, a contact-data service's find) cannot be read again from a website, so a re-ask to it would only wait.
--
-- The worker drafts a re-ask only once its contact was verified in the last 80 days (server/growth/draft.mjs), so a draft cannot
-- wait for approval past the claim's 90 days. No table, setting, grant or declared feature changes.
set local lock_timeout = '10s';

create or replace function private.growth_contact_candidates(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$ begin
 perform private.require_hub_app_server();
 if p_limit is null or p_limit<1 or p_limit>20 then raise exception 'Invalid page' using errcode='22023'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'domain',x.domain) order by x.reask,x.discovered_at,x.id),'[]'::jsonb) from (
  select g.id,g.domain,g.discovered_at,not y.missing as reask from private.growth_organizations g
  cross join lateral (select
    -- A business with no contact yet: searched once every 90 days.
    (g.contact_searched_at is null or g.contact_searched_at<now()-interval '90 days')
      and exists(select 1 from private.growth_opportunities o where o.organization_id=g.id and o.contact_id is null and o.stage in ('identified','researched','qualified')) as missing,
    -- A re-ask not yet sent whose role address or evidence would be too old for the claim: read again once a week.
    (g.contact_searched_at is null or g.contact_searched_at<now()-interval '7 days')
      and exists(select 1 from private.growth_opportunities o join private.growth_contacts c on c.id=o.contact_id
        where o.organization_id=g.id and o.owner_agent='marketing_manager' and o.stage='qualified' and o.memory ? 'reengagedAt' and c.eligibility='permitted'
          and not exists(select 1 from private.growth_messages m where m.opportunity_id=o.id and m.purpose='marketing' and m.attempted_at is not null
            and m.attempted_at>=case when (o.memory->>'reengagedAt') ~ '^\d{4}-\d{2}-\d{2}' then (o.memory->>'reengagedAt')::timestamptz end)
          and ((c.source_kind='role_address' and (c.verified_at is null or c.verified_at<now()-interval '80 days'))
            or not exists(select 1 from private.growth_evidence e where e.opportunity_id=o.id and e.observed_at>now()-interval '21 days'
              and e.observed_at<=now() and e.claim not like 'Research only, not for outreach:%'))) as reask) y
  where g.discovered_at is not null and not g.internal and g.tenant_id is null and (y.missing or y.reask)
  order by not y.missing,g.discovered_at,g.id limit p_limit) x);
end; $$;

-- The same as 20261113170000_growth_trial_link.sql, except that evidence seen again past research is dated now.
create or replace function private.growth_discover(p_product text,p_rows jsonb) returns integer
language plpgsql security definer set search_path='' as $$ declare r jsonb; v_org uuid; v_opp uuid; v_stage text; v_n integer:=0; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 if p_product not in ('carebase','caremetric-intel') or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>10 then raise exception 'Invalid discovery' using errcode='22023'; end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  insert into private.growth_organizations(name,domain,discovered_at) values(left(r->>'name',200),r->>'domain',now()) on conflict(domain) do nothing;
  select id into v_org from private.growth_organizations where domain=r->>'domain' and tenant_id is null and not internal;
  continue when v_org is null;
  insert into private.growth_opportunities(organization_id,product) values(v_org,p_product) on conflict do nothing;
  select id,stage into v_opp,v_stage from private.growth_opportunities where organization_id=v_org and product=p_product;
  -- Seen again: past research it was observed now, so a later message (a re-ask among them) can cite it. Before qualification a
  -- duplicate changes nothing and never buys a new assessment.
  insert into private.growth_evidence(opportunity_id,source_url,claim,confidence,observed_at) values(v_opp,r->>'url',left(r->>'claim',4000),'low',now())
  on conflict (opportunity_id,source_url,claim) do update set observed_at=excluded.observed_at where v_stage in ('qualified','contacted');
  v_n:=v_n+1;
 end loop;
 return v_n;
end; $$;

-- The same as 20261113172000_growth_reengage.sql, except that the contact's address must be one that can be current when it is sent.
create or replace function private.growth_reengage(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_days integer := private.growth_recontact_days(); v_n integer; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_limit is null or p_limit < 1 or p_limit > 200 then raise exception 'Invalid page' using errcode = '22023'; end if;
 with facts as (
   select o.id, o.organization_id, o.stage,
     (select max(m.attempted_at) from private.growth_messages m where m.opportunity_id = o.id and m.purpose = 'marketing' and m.attempted_at is not null) as last_touch,
     (select count(*) from private.growth_messages m where m.opportunity_id = o.id and m.purpose = 'marketing' and m.attempted_at is not null) as touches,
     (select e.kind from private.customer_activity_events e where e.organization_id = o.organization_id
        and e.kind in ('reply', 'positive_reply', 'negative_reply', 'not_now') order by e.occurred_at desc limit 1) as last_reply,
     (select max(e.occurred_at) from private.customer_activity_events e where e.organization_id = o.organization_id
        and e.kind in ('reply', 'positive_reply', 'negative_reply', 'not_now')) as replied_at,
     (select max((t.facts ->> 'ownershipChanged')::date) from private.growth_roster_targets t where t.organization_id = o.organization_id
        and t.facts ->> 'ownershipChanged' ~ '^\d{4}-\d{2}-\d{2}$') as ownership_changed,
     p.max_touches
   from private.growth_opportunities o
   join private.growth_organizations g on g.id = o.organization_id
   join private.growth_contacts c on c.id = o.contact_id
   join private.growth_policies p on p.product = o.product
   where o.owner_agent = 'marketing_manager' and o.stage in ('nurture', 'contacted') and not (o.memory ? 'reengagedAt')
     and not g.internal and g.tenant_id is null and c.eligibility = 'permitted'
     -- An address that can be current when the re-ask is sent: a public role address the contact finder can see again on the
     -- business's own site, or any other address verified in the last 80 days (a person's address is never re-read from a website).
     and (c.source_kind = 'role_address' or c.verified_at >= now() - interval '80 days')
     and not exists (select 1 from private.email_suppressions s where s.email_hash = encode(extensions.digest(c.email, 'sha256'), 'hex'))
     and not exists (select 1 from private.customer_activity_events e where e.organization_id = o.organization_id
       and e.kind in ('negative_reply', 'cancel_requested', 'trial_started', 'signup', 'paid', 'meeting_booked'))),
 due as (
   select f.*, case
     when f.ownership_changed is not null and f.last_touch is not null and f.ownership_changed > f.last_touch::date and f.last_touch < now() - interval '14 days' then 'new_owner'
     when f.last_reply = 'not_now' and f.replied_at < now() - make_interval(days => v_days) then 'not_now'
     when f.last_reply is null and f.stage = 'contacted' and f.touches >= f.max_touches and f.last_touch < now() - make_interval(days => v_days) then 'silent'
   end as why
   from facts f),
 chosen as (select d.* from due d where d.why is not null order by d.last_touch nulls first, d.id limit p_limit)
 update private.growth_opportunities o set stage = 'qualified',
   memory = o.memory || jsonb_build_object('reengagedAt', now(), 'reengageReason', chosen.why, 'touchesBefore', chosen.touches),
   next_action = 'Ask once more, briefly', next_at = now(), version = o.version + 1, updated_at = now()
 from chosen where o.id = chosen.id;
 get diagnostics v_n = row_count;
 if v_n > 0 then insert into private.audit_events(actor_id, action, entity_type, metadata) values (null, 'growth.reengaged', 'growth', jsonb_build_object('count', v_n, 'days', v_days)); end if;
 return jsonb_build_object('reengaged', v_n, 'days', v_days);
end; $$;

do $$
declare r text; f text;
begin
  foreach f in array array['private.growth_contact_candidates(integer)', 'private.growth_discover(text,jsonb)', 'private.growth_reengage(integer)',
                           'private.growth_record_contact(uuid,text,text)'] loop
    if not exists (select 1 from pg_proc where oid = f::regprocedure and prosecdef and proconfig @> array['search_path=""'] and prosrc like '%require_hub_app_server%')
       or not has_function_privilege('hub_app_server', f, 'execute') then
      raise exception '% must stay a Hub server function', f using errcode = '55000';
    end if;
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, f, 'execute') then raise exception '% exposed to %', f, r using errcode = '55000'; end if;
    end loop;
  end loop;
  if not exists (select 1 from pg_proc where oid = 'private.growth_contact_candidates(integer)'::regprocedure
                   and prosrc like '%reengagedAt%' and prosrc like '%interval ''80 days''%' and prosrc like '%interval ''7 days''%') then
    raise exception 'The contact finder must read a pending re-ask''s site again' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_proc where oid = 'private.growth_record_contact(uuid,text,text)'::regprocedure and prosrc like '%verified_at=now()%') then
    raise exception 'Finding the same address again must re-verify it' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_proc where oid = 'private.growth_discover(text,jsonb)'::regprocedure
                   and prosrc like '%tenant_id is null and not internal%' and prosrc like '%do update set observed_at=excluded.observed_at where v_stage in (''qualified'',''contacted'')%') then
    raise exception 'Evidence seen again past research must be dated now, and discovery must never prospect a customer' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_proc where oid = 'private.growth_reengage(integer)'::regprocedure
                   and prosrc like '%c.source_kind = ''role_address'' or c.verified_at >= now() - interval ''80 days''%') then
    raise exception 'A re-ask must start only for an address that can be current when it is sent' using errcode = '55000';
  end if;
end $$;
