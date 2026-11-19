-- Leads from Google search ads reported to Google (owner request 2026-11-19). The November 18 read-back found the Google Ads account
-- auto-tagging (each click carries a gclid, which Intel's lead form passes to the Hub) but tracking no conversions, so Google could not
-- count a lead its ad brought. With Settings → Paid ads → "Report leads to the ad platforms" on and the new "Google Ads conversion action
-- id" set, the Social Media Manager uploads each county report or trial lead that carries a gclid to that conversion action as an
-- offline click conversion: the gclid, when the lead happened and the lead's id as the order id, and nothing else (no email, no name).
--
-- Nothing runs until the owner sets the conversion action id, and that setting can be saved only once this migration has added its row.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values ('ads.google_conversion_action', 'text') on conflict (key) do nothing;

-- Google joins Meta and LinkedIn as a platform a lead is reported to, once per lead and platform.
alter table private.ads_conversions drop constraint if exists ads_conversions_platform_check;
alter table private.ads_conversions add constraint ads_conversions_platform_check check (platform in ('meta', 'linkedin', 'google'));

-- Server: county report and trial leads of the last seven days not yet reported to `p_platform`, with what a report needs. Unchanged
-- but for Google: the email leaves only as a hash for Meta and LinkedIn, and not at all for Google; test and probe leads never.
create or replace function private.ads_conversion_candidates(p_platform text, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
  perform private.require_hub_app_server();
  if p_platform is null or p_platform not in ('meta', 'linkedin', 'google') or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'kind', l.kind, 'email', l.contact_email, 'occurredAt', l.occurred_at, 'clickIds', l.click_ids,
      'landingPath', l.landing_path, 'firstSeenAt', l.first_seen_at) order by l.occurred_at)
    from (select * from private.leads l where l.kind in ('county_report', 'trial_signup') and not l.test and l.contact_email is not null
            and l.occurred_at >= now() - interval '7 days'
            and not exists (select 1 from private.ads_conversions c where c.lead_id = l.id and c.platform = p_platform)
          order by l.occurred_at limit p_limit) l), '[]'::jsonb);
end; $$;

-- The table's platform check is what ads_conversion_record (unchanged) now accepts Google under.
revoke all on function private.ads_conversion_candidates(text, integer) from public, anon, authenticated, service_role;
grant execute on function private.ads_conversion_candidates(text, integer) to hub_app_server;
