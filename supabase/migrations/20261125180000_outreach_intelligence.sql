-- First-email intelligence (the November 25 review). Nothing here sends mail, and nothing changes until the owner
-- turns a setting on. The bounce pause and the strict address check are not touched.
--
-- 1. Three settings, all off:
--    growth.email_one_fact: the first email may add one positive Intel fact (4+ stars, or rising Medicare patients).
--    growth.email_one_offer: the first email may add a P.S. with the trial and the Founders Sale.
--    growth.booking_url: an https link. Empty: the first email offers no walkthrough.
-- 2. A first email the reader still scores under 4 after its rewrite is not approved on its own. The arms key
--    hold_review = critic tells private.growth_propose to leave the action proposed.
-- 3. Drafts still quoting the old 50% Founders Sale, and not yet sent, are cancelled and their approval is turned
--    down, so the next sweep can write them again at 75%. A message already at the provider is left alone.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.email_one_fact', 'flag'),
  ('growth.email_one_offer', 'flag'),
  ('growth.booking_url', 'text')
on conflict (key) do nothing;

-- A weak first email waits for the owner even when cold email is handed over.
do $$
declare
  d text := pg_get_functiondef('private.growth_propose(uuid,uuid)'::regprocedure);
  old_line constant text := 'if v_trusted then';
  new_line constant text := 'if v_trusted and coalesce(m.arms ->> ''hold_review'', '''') <> ''critic'' then';
begin
  if position(new_line in d) > 0 then return; end if;
  if position(old_line in d) = 0 then
    raise exception 'private.growth_propose changed; update this migration' using errcode = '55000';
  end if;
  execute replace(d, old_line, new_line);
end $$;

-- Queued drafts that still say 50% off. Sent mail is not rewritten.
with retired as (
  update private.growth_messages
     set status = 'cancelled', withdrawn_at = coalesce(withdrawn_at, now())
   where status in ('draft', 'proposed')
     and (body ~* 'founders sale:[[:space:]]*50%[[:space:]]*off'
       or body ~* '50%[[:space:]]*off your first 12 months'
       or body ~* '50%[[:space:]]*off eligible')
     and body !~* '75%[[:space:]]*off'
  returning id, action_id
)
update private.agent_actions a
   set status = 'rejected',
       decision_note = 'Retired: this draft still quotes the old 50% Founders Sale.',
       decided_at = now(),
       updated_at = now()
  from retired r
 where a.id = r.action_id
   and a.status in ('proposed', 'approved', 'auto_approved');
