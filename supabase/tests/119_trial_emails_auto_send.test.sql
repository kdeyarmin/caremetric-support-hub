begin;
select plan(3);

-- The trial path's three customer emails join the Account emails step (20261117245000_trial_emails_auto_send.sql).
select ok((select (c -> 'values') @> '["card_reminder", "midtrial_nudge", "value_followup"]'::jsonb
    from private.agent_autonomy_steps s, jsonb_array_elements(s.changes) c
   where s.category = 'account_emails' and c ->> 'agent' = 'account_manager' and c ->> 'config_key' = 'auto_send_templates'),
  'The Account emails step lists the card reminder and both mid-trial emails');
select ok(not (select (c -> 'values') ?| array['cancel_save', 'trial_ended']
    from private.agent_autonomy_steps s, jsonb_array_elements(s.changes) c
   where s.category = 'account_emails' and c ->> 'agent' = 'account_manager' and c ->> 'config_key' = 'auto_send_templates'),
  'The cancellation and ended-trial check-ins are never sent on their own');
select is((select jsonb_array_length(c -> 'values')
    from private.agent_autonomy_steps s, jsonb_array_elements(s.changes) c
   where s.category = 'account_emails' and c ->> 'agent' = 'account_manager' and c ->> 'config_key' = 'auto_send_templates'), 7,
  'Seven templates, each listed once');

select * from finish();
rollback;
