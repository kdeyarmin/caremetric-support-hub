-- Learning what works (AI workforce review 2026-11-12, P2: "nothing learns from outcomes"). Each week the Marketing Manager reads
-- what happened to its emails, by the arms they were written under (20261113170000), and writes a short memo the owner approves:
--
-- - private.growth_learning_facts: counts only. Per product, the last 90 days of sent outreach by each arm value (sent, replied,
--   positive, negative, not now, bounced), reply kinds, the playbook objections the Sales Executive recorded, and the owner's own notes
--   on drafts they turned down (the owner's words, never a prospect's). No message text, address or name.
-- - private.growth_learning_memos: the memos, one active per product at most. A memo is proposed; it takes effect only when the owner
--   chooses "Use this memo" on the Growth screen, and Settings -> Customer growth -> "Write from what is working" is on.
-- - growth_messages.memo_version: the memo a draft was written with, so a memo can be judged by the replies it brings.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.learning_memo', 'flag')
on conflict (key) do nothing;

alter table private.growth_messages add column if not exists memo_version integer check (memo_version between 1 and 100000);

create table private.growth_learning_memos (
  id uuid primary key default gen_random_uuid(),
  product text not null check (product in ('carebase', 'caremetric-intel')),
  version integer not null check (version between 1 and 100000),
  memo text not null check (char_length(memo) between 1 and 2000),
  stats jsonb not null default '{}' check (jsonb_typeof(stats) = 'object' and pg_column_size(stats) <= 16000),
  status text not null default 'proposed' check (status in ('proposed', 'active', 'retired', 'rejected')),
  decided_by uuid,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (product, version)
);
create unique index growth_learning_memos_active on private.growth_learning_memos (product) where status = 'active';
alter table private.growth_learning_memos enable row level security;
revoke all on private.growth_learning_memos from public, anon, authenticated, service_role, hub_app_server;

-- Server: what happened to the last p_days of a product's outreach, in counts.
create function private.growth_learning_facts(p_product text, p_days integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 if p_product not in ('carebase', 'caremetric-intel') or p_days is null or p_days < 7 or p_days > 365 then raise exception 'Invalid window' using errcode = '22023'; end if;
 return (with sent as (
   select m.id, m.arms, m.memo_version, m.attempted_at, o.organization_id, m.status
   from private.growth_messages m join private.growth_opportunities o on o.id = m.opportunity_id
   where o.product = p_product and m.purpose = 'marketing' and m.attempted_at is not null and m.attempted_at >= now() - make_interval(days => p_days)),
 outcome as (
   select s.*,
     (select e.kind from private.customer_activity_events e where e.organization_id = s.organization_id and e.occurred_at >= s.attempted_at
        and e.occurred_at < s.attempted_at + interval '30 days' and e.kind in ('reply', 'positive_reply', 'negative_reply', 'not_now')
      order by e.occurred_at limit 1) as reply,
     s.status in ('bounced', 'complaint') or exists (select 1 from private.growth_delivery_events d where d.message_id = s.id and d.kind in ('bounced', 'complaint')) as bounced
   from sent s),
 arms as (
   select a.key as arm, a.value as value, count(*) as sent, count(*) filter (where o.reply is not null) as replied,
     count(*) filter (where o.reply = 'positive_reply') as positive, count(*) filter (where o.reply = 'negative_reply') as negative,
     count(*) filter (where o.reply = 'not_now') as not_now, count(*) filter (where o.bounced) as bounced
   from outcome o, jsonb_each_text(o.arms) a group by a.key, a.value)
 select jsonb_build_object(
   'product', p_product, 'days', p_days,
   'sent', (select count(*) from outcome), 'replied', (select count(*) from outcome where reply is not null),
   'positive', (select count(*) from outcome where reply = 'positive_reply'), 'bounced', (select count(*) from outcome where bounced),
   'arms', coalesce((select jsonb_agg(jsonb_build_object('arm', arm, 'value', value, 'sent', sent, 'replied', replied, 'positive', positive,
       'negative', negative, 'notNow', not_now, 'bounced', bounced) order by arm, value) from arms), '[]'::jsonb),
   'memos', coalesce((select jsonb_agg(jsonb_build_object('version', memo_version, 'sent', n, 'replied', r) order by memo_version) from (
       select memo_version, count(*) n, count(*) filter (where reply is not null) r from outcome where memo_version is not null group by memo_version) x), '[]'::jsonb),
   'objections', coalesce((select jsonb_object_agg(objection, n) from (
       select e.facts ->> 'objection' as objection, count(*) n from private.customer_activity_events e
        where e.product = p_product and e.facts ? 'objection' and e.occurred_at >= now() - make_interval(days => p_days)
          and e.facts ->> 'objection' ~ '^[a-z_]{1,30}$' group by 1) x), '{}'::jsonb),
   'ownerNotes', coalesce((select jsonb_agg(left(note, 300)) from (
       select a.decision_note as note from private.agent_actions a join private.growth_messages m on m.action_id = a.id
        join private.growth_opportunities o on o.id = m.opportunity_id
        where a.kind = 'growth.message' and a.status = 'rejected' and o.product = p_product and nullif(btrim(a.decision_note), '') is not null
          and a.decided_at >= now() - make_interval(days => p_days)
        order by a.decided_at desc limit 5) x), '[]'::jsonb),
   -- Why drafts were thrown away by the code checks (the pipeline sweep's `rejected` counts, draft.mjs codes), across products.
   'draftChecks', coalesce((select jsonb_object_agg(code, n) from (
       select r.key as code, sum((r.value #>> '{}')::numeric)::integer as n
       from private.agent_tasks t cross join lateral jsonb_each(case when jsonb_typeof(t.result -> 'rejected') = 'object' then t.result -> 'rejected' else '{}'::jsonb end) r
       where t.kind = 'growth.pipeline' and t.status = 'done' and t.finished_at >= now() - make_interval(days => p_days)
         and r.key ~ '^[a-z_]{1,80}$' and jsonb_typeof(r.value) = 'number'
       group by 1 order by 2 desc limit 30) x), '{}'::jsonb),
   'rejectedDrafts', (select count(*) from private.agent_actions a join private.growth_messages m on m.action_id = a.id
        join private.growth_opportunities o on o.id = m.opportunity_id
        where a.kind = 'growth.message' and a.status = 'rejected' and o.product = p_product and a.decided_at >= now() - make_interval(days => p_days)))
 );
end; $$;

-- Server: a new memo, proposed for the owner. The previous proposal for the product, never decided, is replaced.
create function private.growth_learning_propose(p_product text, p_memo text, p_stats jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_version integer; v_id uuid; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_product not in ('carebase', 'caremetric-intel') or char_length(coalesce(p_memo, '')) not between 1 and 2000 or jsonb_typeof(p_stats) <> 'object' then
  raise exception 'Invalid memo' using errcode = '22023';
 end if;
 if exists (select 1 from private.growth_learning_memos where product = p_product and memo = p_memo and status in ('proposed', 'active')) then
  return jsonb_build_object('proposed', false, 'reason', 'unchanged');
 end if;
 update private.growth_learning_memos set status = 'rejected', decided_at = now() where product = p_product and status = 'proposed';
 select coalesce(max(version), 0) + 1 into v_version from private.growth_learning_memos where product = p_product;
 insert into private.growth_learning_memos(product, version, memo, stats) values (p_product, v_version, p_memo, p_stats) returning id into v_id;
 return jsonb_build_object('proposed', true, 'id', v_id, 'version', v_version);
end; $$;

-- Server: the product's active memo, or null.
create function private.growth_learning_active(p_product text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 return (select jsonb_build_object('version', version, 'memo', memo) from private.growth_learning_memos where product = p_product and status = 'active');
end; $$;

-- Owner (Growth screen): the latest memos per product.
create function hub.growth_learning(p_limit integer default 6) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform hub.authorize_app_admin();
 return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'product', product, 'version', version, 'memo', memo, 'status', status, 'createdAt', created_at,
   'stats', jsonb_build_object('sent', stats -> 'sent', 'replied', stats -> 'replied')) order by created_at desc), '[]'::jsonb)
  from (select * from private.growth_learning_memos order by created_at desc limit least(greatest(coalesce(p_limit, 6), 1), 20)) m);
end; $$;

-- Owner: use a proposed memo (the product's active one retires) or turn it down.
create function hub.growth_learning_decide(p_id uuid, p_decision text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; m private.growth_learning_memos%rowtype; begin
 v_actor := (hub.authorize_app_command() ->> 'user_id')::uuid;
 perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_decision not in ('activate', 'reject') then raise exception 'Invalid decision' using errcode = '22023'; end if;
 select * into m from private.growth_learning_memos where id = p_id for update;
 if not found or m.status <> 'proposed' then raise exception 'This memo is not waiting for a decision' using errcode = '22023'; end if;
 if p_decision = 'activate' then
  update private.growth_learning_memos set status = 'retired', decided_at = now() where product = m.product and status = 'active';
 end if;
 update private.growth_learning_memos set status = case when p_decision = 'activate' then 'active' else 'rejected' end, decided_by = v_actor, decided_at = now() where id = m.id;
 insert into private.audit_events(actor_id, action, entity_type, metadata)
 values (v_actor, 'growth.memo_' || case when p_decision = 'activate' then 'activated' else 'rejected' end, 'growth', jsonb_build_object('product', m.product, 'version', m.version));
 return jsonb_build_object('status', case when p_decision = 'activate' then 'active' else 'rejected' end, 'version', m.version);
end; $$;

-- Drafts record the memo they were written with.
create or replace function private.growth_draft(p_opportunity uuid,p_work uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$ declare v_o private.growth_opportunities%rowtype; v_id uuid; v_contact_version integer; v_policy_version integer; v_arms jsonb; v_memo integer; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 select * into v_o from private.growth_opportunities where id=p_opportunity for update;
 if not found or v_o.contact_id is null or v_o.version is distinct from (p_data->>'version')::integer then raise exception 'Opportunity changed or lacks contact' using errcode='40001'; end if;
 select version into v_contact_version from private.growth_contacts where id=v_o.contact_id;
 select version into v_policy_version from private.growth_policies where product=v_o.product;
 if v_contact_version is distinct from (p_data->>'contactVersion')::integer or v_policy_version is distinct from (p_data->>'policyVersion')::integer then
  raise exception 'Draft context changed; regenerate from the current contact and policy' using errcode='40001';
 end if;
 if not exists(select 1 from private.customer_success_plans where id=p_work and opportunity_id=p_opportunity and status='open') then raise exception 'Work no longer open' using errcode='40001'; end if;
 -- Arms are short codes only: never text from the message or the prospect.
 v_arms:=coalesce((select jsonb_object_agg(key,value) from jsonb_each_text(case when jsonb_typeof(p_data->'arms')='object' then p_data->'arms' else '{}'::jsonb end)
   where key ~ '^[a-z_]{1,20}$' and value ~ '^[a-z0-9_.-]{1,40}$'),'{}'::jsonb);
 v_memo:=case when (p_data->>'memoVersion') ~ '^[0-9]{1,6}$' then (p_data->>'memoVersion')::integer end;
 insert into private.growth_messages(opportunity_id,work_id,contact_id,purpose,subject,body,citations,opportunity_version,contact_version,policy_version,unsubscribe_hash,variant,model_generated,arms,memo_version)
 select v_o.id,p_work,c.id,p_data->>'purpose',p_data->>'subject',p_data->>'body',p_data->'citations',v_o.version,c.version,p.version,p_data->>'unsubscribeHash',coalesce(p_data->>'variant','control'),coalesce((p_data->>'modelGenerated')::boolean,false),v_arms,v_memo
 from private.growth_contacts c join private.growth_policies p on p.product=v_o.product where c.id=v_o.contact_id
 on conflict(work_id,opportunity_version,contact_version,policy_version) where withdrawn_at is null do nothing returning id into v_id;
 if v_id is null then select id into v_id from private.growth_messages where work_id=p_work and opportunity_version=v_o.version and contact_version=(select version from private.growth_contacts where id=v_o.contact_id) and policy_version=(select version from private.growth_policies where product=v_o.product) and withdrawn_at is null; end if;
 return (select jsonb_build_object('id',id,'subject',subject,'body',body,'status',status,'actionId',action_id) from private.growth_messages where id=v_id);
end; $$;

revoke all on function private.growth_learning_facts(text, integer), private.growth_learning_propose(text, text, jsonb), private.growth_learning_active(text)
  from public, anon, authenticated, service_role;
grant execute on function private.growth_learning_facts(text, integer), private.growth_learning_propose(text, text, jsonb), private.growth_learning_active(text) to hub_app_server;
revoke all on function hub.growth_learning(integer), hub.growth_learning_decide(uuid, text) from public, anon, service_role;
grant execute on function hub.growth_learning(integer), hub.growth_learning_decide(uuid, text) to authenticated;

-- Every morning; the memo is written on Mondays (server/growth/learning.mjs).
insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('marketing_manager', 'growth.learn', 'daily', null, '07:20', 'America/New_York', false,
  private.agent_schedule_next('daily', null, '07:20', 'America/New_York', now(), null))
on conflict (agent_key, task_kind) do nothing;
