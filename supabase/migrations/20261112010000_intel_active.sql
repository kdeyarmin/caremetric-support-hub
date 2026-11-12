-- CareMetric Intel is past its pilot: it takes paid subscriptions through Hub billing and is the product the team markets.
-- The status is a label on the Hub's product list and support readiness; no rule treats a pilot product differently from an active one.
set local lock_timeout='10s';

update hub.products set status='active' where slug='caremetric-intel' and status='pilot';
