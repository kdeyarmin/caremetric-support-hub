-- The report-led style is a separate, noncomparative treatment.
alter table private.growth_messages drop constraint growth_messages_variant_check;
alter table private.growth_messages add constraint growth_messages_variant_check check (variant in ('control', 'concise', 'report'));

-- Filter historical mislabeled report-led length treatments at read time; no message rows are rewritten.
create or replace function private.growth_learning_facts(p_product text, p_days integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 if p_product not in ('carebase', 'caremetric-intel') or p_days is null or p_days < 7 or p_days > 365 then raise exception 'Invalid window' using errcode = '22023'; end if;
 return (with sent as (
   select m.id,
     -- growth.11 did not persist its prompt version or actual length treatment. Conservatively omit
     -- legacy cold first touches created since report-led copy began, including drafts sent later.
     case when p_product = 'caremetric-intel' and not (m.arms ? 'length_basis')
       and m.created_at >= timestamptz '2026-11-15 00:00:00+00'
       and coalesce(m.arms ->> 'trigger', '') <> 'inbound'
       and coalesce(m.arms ->> 'trigger', '') not like 'reask_%'
       and not exists (select 1 from private.growth_messages prior
         where prior.opportunity_id = m.opportunity_id and prior.purpose = 'marketing'
           and prior.primary_message_id is null and prior.attempted_at < m.created_at)
       then m.arms - 'length' else m.arms end as arms, m.memo_version, m.attempted_at, o.organization_id, m.status
   from private.growth_messages m join private.growth_opportunities o on o.id = m.opportunity_id
   where o.product = p_product and m.purpose = 'marketing' and m.attempted_at is not null and m.attempted_at >= now() - make_interval(days => p_days)
     and m.primary_message_id is null),
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
          and a.decided_at >= now() - make_interval(days => p_days) and m.primary_message_id is null
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
        where a.kind = 'growth.message' and a.status = 'rejected' and o.product = p_product and a.decided_at >= now() - make_interval(days => p_days)
          and m.primary_message_id is null))
 );
end; $$;
