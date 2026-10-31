-- Healthcare Advisors returns to the owner's administration screens: its consultation requests are managed from the
-- Hub again (control center, Applications, Communications import), and its published FAQ answers are Hub guidance
-- again, as before 20261028220500_limit_central_hub_to_three_apps.sql. It stays out of every customer-facing feature:
-- private.hub_application_enabled() still lists only CareBase, Breathe and Intel, so self-service, application billing
-- keys and customer billing keep refusing it, and platform billing excludes Advisors by slug.
set local lock_timeout='10s';

update hub.products set status='active', support_enabled=true where slug='advisors';

do $$
declare advisors uuid := (select id from hub.products where slug='advisors');
begin
  if advisors is null or not exists(select 1 from hub.products where id=advisors and status='active' and support_enabled) then
    raise exception 'Healthcare Advisors could not be restored' using errcode='55000';
  end if;
  if private.hub_application_enabled(advisors) then
    raise exception 'Healthcare Advisors must stay out of customer-facing features' using errcode='55000';
  end if;
  if private.communication_product('advisors') is distinct from advisors then
    raise exception 'Consultation requests must be filed under Healthcare Advisors' using errcode='55000';
  end if;
end $$;
