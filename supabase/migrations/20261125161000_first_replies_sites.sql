-- The website search's sites (the Nov 24 measurement, docs/AI_WORKFORCE_REVIEW_2026-11-17_TEAM.md; docs/CUSTOMER_GROWTH.md, "Search the web
-- for roster agencies not found"). On 2026-11-25, of 87 roster agencies the web search had searched and not found, 53 had a fragment of
-- the research answer's prose stored as a suggested site ("apparently.https", "string.none") and 22 nothing else, so the site the
-- answer named was never read; and the sites that were read were judged only by their home page's opening text. The server now reads
-- only addresses written as such, more of each site, and any page that names the agency, its town and its state (server/growth/
-- site-search.mjs, sites.2). This migration:
--
-- 1. A roster agency may be confirmed by the owner ('owner'), beside its CMS telephone number ('phone') and its name and place ('name').
--    private.growth_roster_resolved takes it, patched in place (it is pinned by 20261113170600_growth_roster_contract.sql), and a host
--    already serving three agencies takes an owner's choice as it takes a telephone number: the owner has looked.
-- 2. hub.growth_roster_use_site(ccn, domain): the owner's "Use this site" on Growth (owner decision 2026-11-24, superseding the
--    2026-11-16 "no approve button"). Only for an agency still not found, only a domain among that agency's stored suggestions (which
--    the server kept only if it was a business's own host: never a directory, listing, social network or government page), through the
--    same private.growth_roster_resolved as a code-confirmed site, recorded with the owner as actor. The business's public address is
--    then found by the usual contact sweep, and nothing is sent to it until the usual checks pass.
-- 3. The prose fragments are removed from the stored suggestions, and every agency the search did not find before this migration is
--    searched once more with the new reading (once: an audit row marks it). At most "Most agencies to search the web for a day" a day.
--
-- Nothing is sent by this migration. The contract (the follow-up's second part) declares platform.agents.first-replies-2.v1, and the
-- server offers "Use this site" only then.
set local lock_timeout = '10s';

-- 1. An owner's confirmation. -------------------------------------------------------------------------------------------------------
alter table private.growth_roster_targets drop constraint if exists growth_roster_targets_confirmation_check;
alter table private.growth_roster_targets add constraint growth_roster_targets_confirmation_check
  check (confirmation in ('phone', 'name', 'owner'));

do $$
declare
  d text := pg_get_functiondef('private.growth_roster_resolved(text,jsonb)'::regprocedure);
  old_kinds constant text := 'coalesce(p_data ->> ''confirmation'', '''') not in (''phone'', ''name'')';
  new_kinds constant text := 'coalesce(p_data ->> ''confirmation'', '''') not in (''phone'', ''name'', ''owner'')';
  old_shared constant text := 'if v_shared >= 3 and p_data ->> ''confirmation'' <> ''phone'' then';
  new_shared constant text := 'if v_shared >= 3 and p_data ->> ''confirmation'' not in (''phone'', ''owner'') then';
begin
  if position(new_kinds in d) > 0 and position(new_shared in d) > 0 then return; end if;
  if position(old_kinds in d) = 0 or position(old_shared in d) = 0 then
    raise exception 'private.growth_roster_resolved changed; update this migration' using errcode = '55000';
  end if;
  execute replace(replace(d, old_kinds, new_kinds), old_shared, new_shared);
end $$;

-- 2. The owner's "Use this site". ---------------------------------------------------------------------------------------------------
-- Owner (Growth → Medicare roster): use one of the sites the web search suggested for an agency it did not find. Returns what
-- private.growth_roster_resolved returned ({graduated, organizationId, opportunityId, contactReady}), or {graduated: false, reason:
-- 'changed'} when the agency is no longer waiting (a lookup or a search took it meanwhile).
create or replace function hub.growth_roster_use_site(p_ccn text, p_domain text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; t private.growth_roster_targets%rowtype; v_domain text := lower(btrim(coalesce(p_domain, ''))); v_out jsonb; begin
 v_actor := (hub.authorize_app_command() ->> 'user_id')::uuid;
 perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_ccn is null or p_ccn !~ '^[A-Z0-9]{6,10}$' then raise exception 'Choose an agency' using errcode = '22023'; end if;
 select * into t from private.growth_roster_targets where ccn = p_ccn for update;
 if not found then raise exception 'Choose an agency' using errcode = '22023'; end if;
 if t.status <> 'unresolved' then return jsonb_build_object('graduated', false, 'reason', 'changed'); end if;
 -- Only a site the web search suggested for this agency: the server kept it only as a business's own host (playbook.mjs operatorHost).
 if v_domain !~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$' or char_length(v_domain) > 253 or not (v_domain = any(t.site_suggestions))
    or v_domain ~ '\.(gov|edu|mil)$' or v_domain ~ '\.(gov|edu)\.[a-z]{2}$' then
  raise exception 'Choose one of the sites the web search suggested for this agency' using errcode = '22023';
 end if;
 update private.growth_roster_targets set status = 'resolving', updated_at = now() where ccn = t.ccn;
 v_out := private.growth_roster_resolved(t.ccn, jsonb_build_object('outcome', 'graduated', 'domain', v_domain, 'confirmation', 'owner'));
 update private.growth_roster_targets set site_suggestions = '{}', site_searched_at = coalesce(site_searched_at, now()), updated_at = now()
  where ccn = t.ccn;
 insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
 values (v_actor, 'growth.roster_site_used', 'growth', nullif(v_out ->> 'organizationId', '')::uuid,
   jsonb_build_object('ccn', t.ccn, 'domain', v_domain, 'graduated', coalesce((v_out ->> 'graduated')::boolean, false)));
 return v_out;
end; $$;
revoke all on function hub.growth_roster_use_site(text, text) from public, anon, service_role;
grant execute on function hub.growth_roster_use_site(text, text) to authenticated;

-- 3. The prose fragments go, and the agencies not found are searched once more. --------------------------------------------------------
-- A suggestion is kept only if it ends in a name a business's site uses (the answer's prose ended in "https", "none", "odd", ...).
update private.growth_roster_targets t
   set site_suggestions = coalesce((select array_agg(s order by o) from unnest(t.site_suggestions) with ordinality u(s, o)
       where s ~ '\.(com|net|org|us|info|biz|co|io|health|care|healthcare|agency|services|nursing|clinic|life|family|homes|help|support|center|community|online|site|med|doctor|hospital|hospice|homecare)$'), '{}'),
       updated_at = now()
 where exists (select 1 from unnest(t.site_suggestions) s
                where s !~ '\.(com|net|org|us|info|biz|co|io|health|care|healthcare|agency|services|nursing|clinic|life|family|homes|help|support|center|community|online|site|med|doctor|hospital|hospice|homecare)$');

do $$ begin
  if not exists (select 1 from private.audit_events where action = 'growth.roster_site_research_again') then
    with again as (
      update private.growth_roster_targets set site_searched_at = null, updated_at = now()
       where status = 'unresolved' and site_searched_at is not null returning ccn)
    insert into private.audit_events(actor_id, action, entity_type, metadata)
    select null, 'growth.roster_site_research_again', 'growth', jsonb_build_object('agencies', count(*), 'why', 'first_replies_sites') from again;
  end if;
end $$;
