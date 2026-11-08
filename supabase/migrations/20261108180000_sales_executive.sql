-- The Sales Executive: a new member of the AI team for CareBase and CareMetric Intel. It answers prospects (website leads, sales
-- inquiries and replies to the Marketing Manager's outreach) with drafts checked against the go-to-market fact sheet, moves each one
-- toward a free trial and a paid plan, without demos or meetings, and sends the owner a weekly pipeline review. A drafted answer by email or
-- chat is a `communication.answer`, which waits for the owner until the owner hands "Sales answers" over; everything else is a
-- `communication.reply`, which the reply executor refuses to send unless the owner approved it, whatever the agent's autonomy.
--
-- It starts paused, in Propose. Nothing here sends anything or changes another agent. While it is paused, the Support Concierge keeps
-- handling prospects exactly as before (its fixed sales acknowledgment); once the owner resumes it, the Concierge hands each prospect
-- message to it through private.sales_handoff, after the owner's alert has gone out.

insert into private.agents (key, display_name, role_summary, status, autonomy, model_tier, daily_budget_cents, tool_allowlist, config)
values ('sales_executive', 'Sales Executive',
  'Answers CareBase and Intel prospects with fact-checked drafts, moves each one to a free trial and a paid plan, and reviews the pipeline every week. Every reply waits for your approval.',
  'paused', 'propose', 'draft', 300, array['sales_reply', 'sales_review'], '{"auto_approve_kinds": [], "effort": "medium"}'::jsonb)
on conflict (key) do nothing;

-- The weekly pipeline review fires each morning; every run in an Eastern week shares one alert key, so a server that was down on
-- Monday still reports on the next run and nothing is sent twice.
insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at) values
  ('sales_executive', 'sales.review', 'daily', null, '07:45', 'America/New_York', false,
   private.agent_schedule_next('daily', null, '07:45', 'America/New_York', now(), null))
on conflict (agent_key, task_kind) do nothing;

-- Server: hand one inbound message to the Sales Executive when it is a prospect's and the Sales Executive is working. Returns
-- {handoff, reason?, product?}. A prospect is either
--   * a known growth contact writing from the address on file, for an open (not yet a customer) CareBase or Intel opportunity. Only an
--     email received through the signed provider path binds a sender (the same rule as private.growth_inquiry): chat and form
--     addresses are visitor claims; or
--   * a CareBase or Intel website lead conversation, or one the inbox files as a sales inquiry.
-- Billing and closed conversations, Advisors and every other product stay with the Concierge and the owner. The task carries ids,
-- the product and the opportunity's stage only: never message text, an address or a name. Handing the same message over again is a
-- no-op (the task's request key is the message id).
create function private.sales_handoff(p_communication uuid, p_message uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_agent private.agents%rowtype;
  c private.communications%rowtype;
  m private.communication_messages%rowtype;
  v_product text;
  v_opportunity uuid;
  v_opportunity_product text;
  v_stage text;
  v_contacted boolean;
begin
  perform private.require_hub_app_server();
  select * into v_agent from private.agents where key = 'sales_executive';
  if not found or v_agent.status is distinct from 'active' or v_agent.autonomy = 'observe' then
    return jsonb_build_object('handoff', false, 'reason', 'sales_executive_off');
  end if;
  select * into c from private.communications where id = p_communication;
  if not found then return jsonb_build_object('handoff', false, 'reason', 'not_found'); end if;
  select * into m from private.communication_messages where id = p_message and communication_id = c.id and direction = 'inbound';
  if not found then return jsonb_build_object('handoff', false, 'reason', 'not_found'); end if;
  if c.status = 'closed' or c.inquiry_type is not distinct from 'billing' then
    return jsonb_build_object('handoff', false, 'reason', 'not_sales');
  end if;
  select p.slug into v_product from hub.products p where p.id = c.product_id;

  if c.contact_email is not null and m.provider_message_id like 'email:%' then
    select o.id, o.product, o.stage,
           exists (select 1 from private.growth_messages gm where gm.opportunity_id = o.id and gm.purpose = 'marketing' and gm.attempted_at is not null)
      into v_opportunity, v_opportunity_product, v_stage, v_contacted
    from private.growth_contacts gc
    join private.growth_opportunities o on o.organization_id = gc.organization_id
    join private.growth_organizations g on g.id = o.organization_id
    where gc.email = lower(btrim(c.contact_email)) and not g.internal
      and o.stage in ('identified', 'researched', 'qualified', 'contacted', 'engaged', 'demo', 'nurture')
      and (v_product is null or o.product = v_product)
    order by o.updated_at desc, o.id
    limit 1;
  end if;

  if v_opportunity is null then
    if v_product is null or v_product not in ('carebase', 'caremetric-intel')
      or not (c.source_system in ('carebase.web', 'intel.web') or c.inquiry_type is not distinct from 'sales') then
      return jsonb_build_object('handoff', false, 'reason', 'not_prospect');
    end if;
  else
    v_product := v_opportunity_product;
  end if;

  perform private.agent_task_enqueue('sales_executive', 'sales.reply', 'sales:' || m.id::text,
    jsonb_build_object('communicationId', c.id, 'messageId', m.id, 'product', v_product)
      || case when v_opportunity is null then '{}'::jsonb
              else jsonb_build_object('opportunity', jsonb_build_object('stage', v_stage, 'contacted', coalesce(v_contacted, false))) end,
    3, now(), 'communication', 'CM-' || c.reference::text, false);
  return jsonb_build_object('handoff', true, 'product', v_product);
end;
$$;

-- "Sales answers" (off): after a supervised week, a checked, drafted answer to a prospect, going back by email or chat with at least
-- one cited source, is sent without waiting for the owner, as a `communication.answer` (the session-less path the Concierge's support
-- answers use, which re-checks the agent's trust before sending and authors the message as the CareMetric AI Assistant). The fixed
-- acknowledgment and anything sent by text message still wait for the owner.
insert into private.agent_autonomy_steps (category, label, requires_feature, changes) values
  ('sales_answers', 'Sales answers', 'platform.agents.sales-executive.v1',
    '[{"agent": "sales_executive", "config_key": "auto_approve_kinds", "values": ["communication.answer"]}]')
on conflict (category) do nothing;

revoke all on function private.sales_handoff(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.sales_handoff(uuid, uuid) to hub_app_server;
