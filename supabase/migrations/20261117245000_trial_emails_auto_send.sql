-- The trial path's three customer emails go out on their own (owner decision 2026-11-17, after stage 4 of the team review,
-- docs/AI_WORKFORCE_REVIEW_2026-11-17_TEAM.md): the card reminder, the mid-trial next step and "what to do next" join the Account
-- emails step, beside the welcome, setup help, trial check-in and testimonial request. The step is already automatic in production,
-- so the Account Manager's list gains them now, through the step's own operation (private.agent_autonomy_change); a step that is
-- not automatic only gains them in its list, for when it is. The cancellation and ended-trial check-ins stay out, as before.
-- Only migrations write these lists (2026-11-15 hand-over). Needs the trial path (20261117230000_trial_path.sql), whose checks admit
-- the three templates.
set local lock_timeout = '10s';

do $$
declare
  v_step private.agent_autonomy_steps;
  v_new constant text[] := array['card_reminder', 'midtrial_nudge', 'value_followup'];
begin
  if not (hub.get_backend_contract() -> 'features' ? 'platform.agents.trial-path.v1') then
    raise exception 'Apply the trial path migrations first' using errcode = '55000';
  end if;
  select * into v_step from private.agent_autonomy_steps where category = 'account_emails' for update;
  if not found then return; end if;
  update private.agent_autonomy_steps set changes = (
    select jsonb_agg(case when c ->> 'agent' = 'account_manager' and c ->> 'config_key' = 'auto_send_templates'
      then jsonb_set(c, '{values}', (c -> 'values') || coalesce((select jsonb_agg(t) from unnest(v_new) t where not (c -> 'values') ? t), '[]'::jsonb))
      else c end)
    from jsonb_array_elements(v_step.changes) c)
  where category = 'account_emails';
  if v_step.status = 'automatic' then
    perform private.agent_autonomy_change('account_emails',
      jsonb_build_object('agent', 'account_manager', 'config_key', 'auto_send_templates', 'values', to_jsonb(v_new)), true);
  end if;
end $$;
