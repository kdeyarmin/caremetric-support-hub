-- Outgoing email review (2026-11-17). Three additive changes; the Hub runs the same with or without them (it reads the new keys as absent).
--
-- 1. private.growth_withdraw_message: a growth email the server will not send after claiming it, because its words broke a rule that was
--    added after it was written (worker.mjs `outdatedWords`: an Intel trial with "no credit card", a sentence that implies we saw a report
--    opened, Intel's internal word "the book"). Between November 8 and 15, 23 cold emails promised an Intel trial with no credit card after
--    the trial began to need one, and one more was approved and waiting. The message is cancelled with withdrawn_at, as the hand-over's
--    withdrawal does, so it no longer holds its work's draft key and the next sweep writes that work again under today's rules. Its
--    claim is undone (attempted_at cleared), so it counts toward no cap and no frequency limit. Only a claimed row that never reached the
--    provider ('sending', no provider id) can be withdrawn.
-- 2. private.growth_claim_message also returns `quiet`: the email is a follow-up to a prospect who replied and went quiet (arms.quiet).
--    It is drafted with purpose 'success' so the Sales follow-ups hand-over governs it, but it goes to a prospect from the founder's
--    sending address, so it is signed by the founder like the rest of the prospect's emails, not "The CareMetric Intel team".
-- 3. private.agent_communication_snapshot also returns `sender`, four flags read from the contact address, which itself is still never
--    returned: `machine` (an address only machines write from: noreply, donotreply, mailer-daemon, notifications...), `ours` (the
--    Hub's own support sender or Reply-To, from Settings -> Email, so the Hub's own email coming back), `internal` (another address on the
--    support sender's domain) and `answersOurEmail` (the conversation answers an email the owner sent from the AI team page: the sender
--    was its recipient, or the subject carries its subject). The Support Concierge raises no alert for `ours` and offers no canned
--    acknowledgment or drafted answer for any of them: G2's newsletter and CMS's replies to the owner's own questions were answered
--    "Thank you for contacting CareMetric Support…" in November.
set local lock_timeout = '10s';

create or replace function private.growth_withdraw_message(p_id uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_hub_app_server();
  if p_reason is null or p_reason !~ '^[a-z][a-z_]{0,39}$' then raise exception 'Name why the email is withdrawn.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
  update private.growth_messages set status = 'cancelled', withdrawn_at = now(), attempted_at = null
   where id = p_id and status = 'sending' and provider_id is null
  returning id into v_id;
  if v_id is null then return false; end if;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (null, 'growth.message_withdrawn', 'growth_message', v_id, jsonb_build_object('reason', p_reason));
  return true;
end; $$;
revoke all on function private.growth_withdraw_message(uuid, text) from public, anon, authenticated, service_role;
grant execute on function private.growth_withdraw_message(uuid, text) to hub_app_server;

-- The send claim names a quiet follow-up.
do $$
declare d text := pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure);
begin
  if position('''quiet''' in d) > 0 then return; end if;
  if position($q$'colleague',m.primary_message_id is not null,$q$ in d) = 0 then
    raise exception 'The send claim changed; update this migration' using errcode = '55000';
  end if;
  execute replace(d, $q$'colleague',m.primary_message_id is not null,$q$,
    $q$'colleague',m.primary_message_id is not null,'quiet',coalesce(m.arms ? 'quiet',false),$q$);
end $$;

create or replace function private.agent_communication_snapshot(
  p_id uuid, p_request_key uuid, p_messages integer, p_chars integer
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c private.communications%rowtype;
  v_inbound_id uuid;
  v_inbound_at timestamptz;
  v_head uuid;
  v_answered boolean := false;
  v_messages jsonb := '[]'::jsonb;
  v_address text;
  v_support text;
  v_reply_to text;
begin
  perform private.require_hub_app_server();
  if p_messages is null or p_messages < 0 or p_messages > 10 then
    raise exception 'Read between 0 and 10 messages.' using errcode = '22023';
  end if;
  if p_chars is null or p_chars < 100 or p_chars > 4000 then
    raise exception 'Clip messages to between 100 and 4000 characters.' using errcode = '22023';
  end if;
  select * into c from private.communications where id = p_id;
  if not found then
    return null;
  end if;
  select i.id, i.created_at into v_inbound_id, v_inbound_at from private.communication_messages i
  where i.communication_id = c.id and i.direction = 'inbound'
  order by i.created_at desc, i.id desc limit 1;
  select m.id into v_head from private.communication_messages m
  where m.communication_id = c.id and m.direction in ('inbound', 'outbound')
    and (p_request_key is null or m.request_key is distinct from p_request_key)
  order by m.created_at desc, m.id desc limit 1;
  if v_inbound_id is not null then
    v_answered := exists (
      select 1 from private.communication_messages a
      where a.communication_id = c.id and a.direction in ('outbound', 'note') and (a.created_at, a.id) > (v_inbound_at, v_inbound_id));
  end if;
  if p_messages > 0 then
    select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'direction', t.direction, 'at', t.created_at, 'body', left(t.body, p_chars))
                              order by t.created_at, t.id), '[]'::jsonb)
    into v_messages
    from (
      select m.id, m.direction, m.created_at, m.body from private.communication_messages m
      where m.communication_id = c.id and m.direction in ('inbound', 'outbound')
      order by m.created_at desc, m.id desc limit p_messages) t;
  end if;
  -- Who wrote, as flags only: the address stays here. The support sender and Reply-To are the Settings page's (Settings -> Email).
  v_address := lower(btrim(coalesce(c.contact_email, '')));
  v_support := lower(btrim(coalesce((select s.value #>> '{}' from private.hub_settings s where s.key = 'email.support_from'), 'support@caremetric.ai')));
  v_reply_to := lower(btrim(coalesce((select s.value #>> '{}' from private.hub_settings s where s.key = 'email.reply_to'), '')));
  return jsonb_build_object(
    'id', c.id, 'reference', c.reference, 'channel', c.channel, 'status', c.status, 'inquiryType', c.inquiry_type,
    'sourceSystem', c.source_system,
    'productSlug', (select p.slug from hub.products p where p.id = c.product_id),
    'createdAt', c.created_at, 'updatedAt', c.updated_at,
    'canEmail', c.contact_email is not null,
    'canText', coalesce(c.contact_phone ~ '^\+[1-9][0-9]{7,14}$', false),
    -- Subjects of phone and web-form conversations name the caller, and a text's carries the number.
    'subject', case when c.channel = 'email' then c.subject end,
    'headMessageId', v_head, 'latestInboundId', v_inbound_id, 'answered', v_answered,
    -- How many times each side has written, so a first message (nobody has replied yet) can be told from a follow-up.
    'inboundCount', (select count(*) from private.communication_messages x where x.communication_id = c.id and x.direction = 'inbound'),
    'outboundCount', (select count(*) from private.communication_messages x where x.communication_id = c.id and x.direction = 'outbound'),
    'ownReplyDelivery', (select o.delivery from private.communication_messages o
                         where p_request_key is not null and o.communication_id = c.id and o.direction = 'outbound' and o.request_key = p_request_key),
    'sender', case when c.channel = 'email' and v_address <> '' then jsonb_build_object(
      'machine', v_address ~ '^(?:[^@]*[._+-])?(?:no-?reply|do-?not-?reply|donotreply)(?:[._+-][^@]*)?@'
                 or v_address ~ '^(?:mailer-daemon|postmaster|bounces?|notifications?|alerts?|digest|newsletters?)(?:[._+-][^@]*)?@',
      'ours', v_address = v_support or (v_reply_to <> '' and v_address = v_reply_to),
      'internal', split_part(v_address, '@', 2) = split_part(v_support, '@', 2),
      'answersOurEmail', exists (
        select 1 from private.agent_external_emails e
        where e.status in ('sent', 'unknown') and e.created_at > now() - interval '180 days'
          and (lower(btrim(e.recipient)) = v_address
               or (char_length(btrim(e.subject)) >= 8 and position(lower(btrim(e.subject)) in lower(coalesce(c.subject, ''))) > 0))))
      end,
    'messages', v_messages);
end;
$$;

-- Both redefinitions keep their signatures, so their grants are kept; the gate below checks them and the new function.
do $$
declare f text; r text;
begin
  foreach f in array array['private.growth_withdraw_message(uuid,text)', 'private.growth_claim_message(uuid,uuid)',
    'private.agent_communication_snapshot(uuid,uuid,integer,integer)'] loop
    if not exists (select 1 from pg_proc where oid = f::regprocedure and prosecdef and proconfig @> array['search_path=""'] and prosrc like '%require_hub_app_server%')
       or not has_function_privilege('hub_app_server', f, 'execute') then
      raise exception '% must stay a guarded Hub server function', f using errcode = '55000';
    end if;
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, f, 'execute') then raise exception '% exposed to %', f, r using errcode = '55000'; end if;
    end loop;
  end loop;
end $$;
