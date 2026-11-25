-- The Support Concierge answers a message that names no product (the Nov 24 follow-up of the team review, proposal 6;
-- server/growth/first-replies.mjs, docs/AI_WORKFORCE_REVIEW_2026-11-17_TEAM.md).
--
-- An email to the support address carries a product only when it was sent to a "+product" address (support+intel@...): the Hub reads
-- nothing else (server/communications.mjs, productFromAddresses). Nobody writes to those addresses, so all 23 emails of the 60 days to
-- November 24 arrived with no product. Stage 5 (20261117240000_support_truth.sql) let a conversation with no product read every
-- product's guides, but the conversation itself, the owner's alert and what the model was told still named no product.
--
-- 1. private.communication_sender_product(email): the product the sender already uses or asked about, when exactly one: the live
--    subscriptions of their billing account first, then their website leads (never a test), then the Medicare roster prospects of their
--    business (a reply to a cold email). Two products from the first source that knows the sender is "can't tell" (null), never a guess.
--    Internal to the two functions below: executable by no role.
-- 2. private.ingest_inbound_communication (an email or a text arriving) gives a new conversation that product when its address named
--    none. Nothing else in the function changes.
-- 3. private.agent_communication_snapshot (what the Concierge reads) also returns `senderProduct`, for a conversation still without a
--    product (one opened before this migration, or by a sender who became known later). The Concierge then tells the model which product
--    the message is about and how it knows; with none, it drafts from every product's guides and names the product its answer is about
--    (server/agents/concierge/product.mjs, prompt concierge.4).
--
-- No setting: this is a plain fix. 20261124159000_first_replies_contract.sql declares platform.agents.first-replies.v1, and the
-- Concierge reads `senderProduct` only then.
set local lock_timeout = '10s';

-- 1. The sender's one product. ----------------------------------------------------------------------------------------------------------
create or replace function private.communication_sender_product(p_email text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_ids uuid[];
begin
  if v_email = '' or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' then return null; end if;
  -- A customer: the products of their billing account's live subscriptions, whatever their status.
  select array_agg(distinct s.product_id) into v_ids
    from private.billing_customers bc
    join private.billing_subscriptions s on s.tenant_id = bc.tenant_id and s.livemode and s.product_id is not null
   where lower(btrim(bc.email)) = v_email and not bc.deleted and bc.livemode;
  if cardinality(v_ids) = 1 then return v_ids[1]; end if;
  if cardinality(v_ids) > 1 then return null; end if;
  -- Someone who asked on a website: the products of their leads.
  select array_agg(distinct l.product_id) into v_ids
    from private.leads l
   where l.contact_email = v_email and not l.test and l.product_id is not null; -- stored lower case (its check)
  if cardinality(v_ids) = 1 then return v_ids[1]; end if;
  if cardinality(v_ids) > 1 then return null; end if;
  -- A prospect the Marketing Manager wrote to: the products of their business's opportunities.
  select array_agg(distinct p.id) into v_ids
    from private.growth_contacts gc
    join private.growth_opportunities o on o.organization_id = gc.organization_id
    join hub.products p on p.slug = o.product
   where gc.email = v_email;
  if cardinality(v_ids) = 1 then return v_ids[1]; end if;
  return null;
end; $$;
revoke all on function private.communication_sender_product(text) from public, anon, authenticated, service_role, hub_app_server;

-- 2. A new conversation takes the sender's product when its address named none. --------------------------------------------------------
do $$
declare
  d text := pg_get_functiondef('private.ingest_inbound_communication(text,text,text,bigint,text,text,text,text,text,text)'::regprocedure);
  old_product constant text := 'values (p_channel, ''hub.'' || p_channel, p_thread_key, private.communication_product(p_product_slug),';
  new_product constant text := 'values (p_channel, ''hub.'' || p_channel, p_thread_key,
        -- The Nov 24 follow-up (20261124151000_first_replies_concierge.sql): the sender''s one product when the address named none.
        coalesce(private.communication_product(p_product_slug), private.communication_sender_product(v_email)),';
begin
  if position('communication_sender_product' in d) > 0 then return; end if;
  if position(old_product in d) = 0 then
    raise exception 'The inbound message function changed; update this migration' using errcode = '55000';
  end if;
  execute replace(d, old_product, new_product);
end $$;

-- 3. The Concierge's snapshot: the sender's product, for a conversation without one. ----------------------------------------------------
do $$
declare
  d text := pg_get_functiondef('private.agent_communication_snapshot(uuid,uuid,integer,integer)'::regprocedure);
  anchor constant text := '''productSlug'', (select p.slug from hub.products p where p.id = c.product_id),';
begin
  if position('''senderProduct''' in d) > 0 then return; end if;
  if position(anchor in d) = 0 or position('v_address := lower(btrim(coalesce(c.contact_email, '''')));' in d) = 0 then
    raise exception 'The Concierge''s snapshot changed; update this migration' using errcode = '55000';
  end if;
  execute replace(d, anchor, anchor || '
    -- The Nov 24 follow-up (20261124151000_first_replies_concierge.sql): the product the sender already uses or asked about, for a
    -- conversation that names none. A slug only; the address stays here.
    ''senderProduct'', case when c.product_id is null and v_address <> '''' then
      (select p.slug from hub.products p where p.id = private.communication_sender_product(v_address)) end,');
end $$;

-- ---- Checks ----------------------------------------------------------------------------------------------------------------------------
do $$
declare r text; begin
  if to_regprocedure('private.communication_sender_product(text)') is null
    or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p
                     where p.oid = 'private.communication_sender_product(text)'::regprocedure), false) then
    raise exception 'The sender''s product must be a security definer with an empty search path' using errcode = '55000';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_function_privilege(r, 'private.communication_sender_product(text)', 'execute') then
      raise exception 'The sender''s product must stay internal' using errcode = '55000';
    end if;
  end loop;
  if position('communication_sender_product(v_email)' in pg_get_functiondef('private.ingest_inbound_communication(text,text,text,bigint,text,text,text,text,text,text)'::regprocedure)) = 0
    or position('''senderProduct''' in pg_get_functiondef('private.agent_communication_snapshot(uuid,uuid,integer,integer)'::regprocedure)) = 0 then
    raise exception 'A new conversation and the Concierge''s snapshot must read the sender''s product' using errcode = '55000';
  end if;
  if not has_function_privilege('hub_app_server', 'private.ingest_inbound_communication(text,text,text,bigint,text,text,text,text,text,text)', 'execute')
    or not has_function_privilege('hub_app_server', 'private.agent_communication_snapshot(uuid,uuid,integer,integer)', 'execute')
    or has_function_privilege('authenticated', 'private.ingest_inbound_communication(text,text,text,bigint,text,text,text,text,text,text)', 'execute')
    or has_function_privilege('authenticated', 'private.agent_communication_snapshot(uuid,uuid,integer,integer)', 'execute') then
    raise exception 'The inbound message function and the snapshot keep their grants' using errcode = '55000';
  end if;
end $$;
