-- Read a prospect's reply as what they wrote, not as everything in the message (review 2026-11-12, finding P0-2).
--
-- private.growth_inquiry read the whole inbound email, the quoted original included, with loose keyword rules:
--
-- - the old growth footer ("Unsubscribe from these emails: .../api/growth/unsubscribe/..."), quoted under any reply, opted the
--   prospect out and suppressed their address, whatever they wrote above it. Eleven cold emails went out with that footer before
--   it was reworded on 2026-11-12, so a "Yes, tell me more" to any of them would stop all email to that person;
-- - our own "if you're interested" or "book a demo", quoted, made any reply a positive one, and "Not really interested" or "No
--   longer interested" read as positive because only the exact words "not interested" counted against;
-- - "opt out", "take me off" or "stop sending" were not read as requests to stop at all;
-- - a reply from a colleague at the same business (the person written to forwarded it, or answers from the shared inbox) matched
--   no contact and was dropped unless it read as a sales inquiry.
--
-- So:
--
-- - a new private.growth_reply_reading(body) returns {kind, optOut, sales} from the sender's own words: lines quoted with '>' are
--   left out, and so are the "On <date>, <sender> wrote:" line, a growth email's opt-out line (either wording) and links and
--   addresses. Reading stops where a mail program puts the original under a header without marking it (Outlook's "From: / Sent:",
--   "-----Original Message-----", a forward) and at a "wrote:" line whose quote is not marked (an HTML-only email reduced to
--   text). Answers written between '>' lines are kept. The kinds are those growth_inquiry already used, read in the same order:
--   a cancellation, then a refusal ("not really interested", "no thank you", "not a good fit", "we'll pass"), then "not now"
--   ("not right now", "next quarter", "after the holidays", "circle back in"), then interest. A request to stop adds "opt out",
--   "take me off", "stop sending" and "do not email" to the words read before, and is not read from "I don't want to
--   unsubscribe". It is pure and no role may execute it; growth_inquiry and the inbox trigger, which run as its owner, call it;
-- - private.growth_inquiry is replaced with the same signature (grants are kept) and the same body, except that it uses that
--   reading, and that a sender who is not yet a contact, writing from the domain of a business that growth email has reached (a
--   message accepted or delivered to one of its contacts), becomes a contact of that business for review (eligibility 'review':
--   never written to until the owner or the contact finder permits it). The reply then counts as the business's reply, as a
--   contact's reply always has: queued marketing to anyone there already stops at the claim, which refuses a business that has
--   replied. Personal mail domains never link a sender to a business, and the list of them is longer;
-- - private.growth_inbound_trigger is replaced with the same body, except that its fallback, when capture fails, honours a request
--   to stop by the same reading.
--
-- No table, grant, setting or declared feature changes.
set local lock_timeout = '10s';

create function private.growth_reply_reading(p_body text) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_lines text[] := regexp_split_to_array(left(coalesce(p_body, ''), 100000), '\r\n|\r|\n');
  v_n integer;
  v_i integer := 1;
  v_j integer;
  v_line text;
  v_next text;
  v_words text := '';
  v_kind text;
  v_opt_out boolean;
begin
  v_n := coalesce(array_length(v_lines, 1), 0);
  while v_i <= v_n loop
    v_line := v_lines[v_i];
    v_next := coalesce(v_lines[v_i + 1], '');
    -- An Outlook-style reply or a forward puts the original under a header, unmarked: the sender's own words end there.
    exit when v_line ~* '^\s*-{2,}\s*(original message|forwarded message)'
      or v_line ~* '^\s*begin forwarded message\s*:'
      or v_line ~ '^\s*_{8,}\s*$'
      or (v_line ~* '^\s*\*?from\s*:' and array_to_string(v_lines[v_i + 1:v_i + 4], E'\n') ~* '(^|\n)\s*\*?(sent|date)\s*:');
    if v_line ~ '^\s*>' then
      v_i := v_i + 1;
      continue; -- a quoted line
    end if;
    -- "On <date>, <sender> wrote:", on one line or wrapped onto a second.
    v_j := case when v_line ~* '^\s*on\s.*\mwrote\s*:\s*$' then v_i
                when v_line ~* '^\s*on\s' and v_next ~* '\mwrote\s*:\s*$' and length(v_line) + length(v_next) <= 400 then v_i + 1 end;
    if v_j is not null then
      -- When the quote under it is marked with '>', answers written between the quoted lines are the sender's own; when it is
      -- not marked (an HTML-only email reduced to text), everything under it is the original.
      v_i := v_j + 1;
      while v_i <= v_n and btrim(v_lines[v_i]) = '' loop v_i := v_i + 1; end loop;
      exit when v_i <= v_n and v_lines[v_i] !~ '^\s*>';
      continue;
    end if;
    -- The opt-out line of a growth email, old wording or new, wherever a mail program left it unmarked.
    if v_line !~* '^\W*(unsubscribe from|opt out of) these emails\s*($|[:<\[(]|https?://)' then
      v_words := v_words || v_line || E'\n';
    end if;
    v_i := v_i + 1;
  end loop;
  v_words := lower(translate(v_words, E'’‘ ', E'\'\' '));
  v_words := regexp_replace(v_words, '(https?://|www\.|mailto:)\S*|\S+@\S+', ' ', 'g');
  v_words := btrim(regexp_replace(v_words, '\s+', ' ', 'g'));

  v_kind := case
    when v_words ~ '\m(cancel (my|our|the) (account|subscription|service|plan|membership)|close (my|our) account)\M'
      or v_words ~ '\m(want|like|wish) to cancel\M(?! (the |our |my |this |that |tomorrow''s |today''s )?(call|meeting|demo|appointment|session|visit)\M)'
      then case when v_words ~ '\m(not|never|no need to|\w+n''t) (\w+ ){0,2}cancel\M' then null else 'cancel_requested' end
  end;
  v_kind := coalesce(v_kind, case
    when v_words ~ '\m(not|no longer|never|nobody|no one|\w+n''t)\M((?!\m(but|though|although|however|yet)\M)[^.!?;,]){0,80}\minterested\M'
      or v_words ~ '\m(no,? thanks|no,? thank you|not (a|the right|a good|the best) fit|not for us|not in the market|(we|i)(''ll| will) pass)\M'
      then 'negative_reply'
    when v_words ~ '\m(not (right )?now|not at (this|the) (time|moment|point)|not the right time|maybe later|later this year|next (quarter|year)|in the new year|after the (holidays|new year|first of the year)|(contact|reach out to|circle back with|check back with|follow up with) (me|us) (later|in|next|after)|(circle|check) back (later|in|next|after))\M'
      then 'not_now'
    when v_words ~ '\m(interested|demo|(book|schedule|set up|arrange) (a|some) (call|meeting|time)|(send|share) (me|us) (more|some|the|your) (info|information|details|pricing|prices)|tell me more|learn more|(what|how much) (is|are|does|do) (the |your |it )?(price|prices|pricing|cost|costs)|let''s (talk|chat|connect)|(happy|glad|love|like) to (chat|talk|connect|see|learn))\M'
      then 'positive_reply'
    else 'reply'
  end);
  v_opt_out := v_words ~ '\m(unsubscribe|opt (me |us )?out|opt-out|do not (contact|email|e-mail)|don''t (contact|email|e-mail)|stop (emailing|contacting|sending|messaging)|remove (me|us|my (email|address|name)|this (email|address))|take (me|us|my (email|address|name)) off|no (more|further) emails)\M'
    and v_words !~ '\m(not|never|\w+n''t) (want|wish|need|mean|trying) to (unsubscribe|opt out)\M';
  return jsonb_build_object('kind', v_kind, 'optOut', v_opt_out,
    'sales', v_kind not in ('negative_reply', 'cancel_requested') and v_words ~ '\m(demo|pricing|purchase|interested|buy)\M');
end $$;
revoke all on function private.growth_reply_reading(text) from public, anon, authenticated, service_role, hub_app_server;

create or replace function private.growth_inquiry(p_id uuid) returns integer
language plpgsql security definer set search_path='' as $$
declare c private.communications%rowtype; m private.communication_messages%rowtype; v_product text; v_org uuid; v_contact uuid; v_opp uuid; v_message uuid; v_body text; v_reading jsonb; v_reply text; v_domain text; v_n integer:=0;
 v_personal constant text[]:=array['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','yahoo.com','ymail.com','icloud.com','me.com','mac.com','aol.com','comcast.net','verizon.net','att.net','sbcglobal.net','protonmail.com','proton.me']; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 select * into m from private.communication_messages where id=p_id and direction='inbound';
 -- Only email webhook ingestion binds this message to its sender. Chat and form addresses are visitor claims.
 -- Check the message, not the thread: a verified email can join a thread originally opened through a public form.
 if not found or m.provider_message_id is null or m.provider_message_id not like 'email:%' then return 0; end if;
 select * into c from private.communications where id=m.communication_id;
 if not found or c.contact_email is null then return 0; end if;
 select id,organization_id into v_contact,v_org from private.growth_contacts where email=lower(btrim(c.contact_email));
 select slug into v_product from hub.products where id=c.product_id;
 v_message:=m.id; v_body:=m.body;
 -- The sender's own words: quoted text, our footer, links and addresses are not read (private.growth_reply_reading).
 v_reading:=private.growth_reply_reading(v_body); v_reply:=v_reading->>'kind';
 v_domain:=split_part(lower(btrim(c.contact_email)),'@',2);
 -- A colleague answering for a business growth email has reached joins it as a contact for review.
 if v_org is null and v_product in ('carebase','caremetric-intel') and v_domain<>all(v_personal) then
  select g.id into v_org from private.growth_organizations g where g.domain=v_domain and not g.internal
   and exists(select 1 from private.growth_messages gm join private.growth_contacts gc on gc.id=gm.contact_id where gc.organization_id=g.id and gm.status in ('accepted','delivered','unknown'));
  if v_org is not null then
   insert into private.growth_contacts(organization_id,email,name) values(v_org,lower(btrim(c.contact_email)),left(coalesce(c.contact_name,''),200)) on conflict(email) do nothing;
   select id,organization_id into v_contact,v_org from private.growth_contacts where email=lower(btrim(c.contact_email));
  end if;
 end if;
 if v_org is null and v_product in ('carebase','caremetric-intel') and (c.inquiry_type='sales' or (v_reading->>'sales')::boolean) and v_domain<>all(v_personal) then
  insert into private.growth_organizations(name,domain) values(coalesce(nullif(c.organization,''),'Inbound organization'),v_domain) on conflict(domain) do nothing;
  select id into v_org from private.growth_organizations where domain=v_domain;
  insert into private.growth_contacts(organization_id,email,name) values(v_org,lower(btrim(c.contact_email)),left(coalesce(c.contact_name,''),200)) on conflict(email) do nothing;
  select id into v_contact from private.growth_contacts where email=lower(btrim(c.contact_email));
  insert into private.growth_opportunities(organization_id,product,contact_id,stage,next_action) values(v_org,v_product,v_contact,'engaged','Respond to inbound inquiry') on conflict do nothing;
 end if;
 if v_org is null then return 0; end if;
 if (v_reading->>'optOut')::boolean then
  update private.growth_contacts set eligibility='opted_out',version=version+1 where id=v_contact;
  insert into private.email_suppressions(email_hash) values(encode(extensions.digest(lower(btrim(c.contact_email)),'sha256'),'hex')) on conflict do nothing;
 end if;
 -- Any reply stops contact-level sequences across both products. No conversation text is copied.
 update private.growth_messages set status='cancelled' where contact_id=v_contact and status in ('draft','proposed');
 for v_opp in select id from private.growth_opportunities where organization_id=v_org loop
  insert into private.customer_activity_events(product,organization_id,event_key,kind,occurred_at,facts)
  select product,organization_id,'inquiry:'||v_message::text,v_reply,m.created_at,jsonb_build_object('communicationId',c.id) from private.growth_opportunities where id=v_opp on conflict do nothing;
  if found then
   update private.growth_opportunities set owner_agent=case when v_reply='cancel_requested' then 'account_manager' else owner_agent end,stage=case when v_reply in ('not_now','negative_reply') and stage in ('identified','researched','qualified','contacted','engaged') then 'nurture' when stage in ('identified','researched','qualified','contacted') then 'engaged' else stage end,next_action='Review the customer reply in Communications',next_at=now(),version=version+1,updated_at=now() where id=v_opp;
   perform private.growth_plan(v_opp,jsonb_build_object('key','reply:'||v_message::text,'kind',case when v_reply='cancel_requested' then 'recovery' else 'reply' end,'action',case when v_reply='cancel_requested' then 'Review cancellation concerns in Communications and agree a recovery plan.' else 'Review the customer reply in Communications and agree a next step.' end,'success','The customer question is resolved and the next step recorded.','owner',(select owner_agent from private.growth_opportunities where id=v_opp),'dueAt',now()));
   v_n:=v_n+1;
  end if;
 end loop;
 return v_n;
end; $$;

-- The same as 20261104210000_growth_inbound_failsafe.sql, except that the fallback reads a request to stop as capture does.
create or replace function private.growth_inbound_trigger() returns trigger language plpgsql security definer
set search_path='' set lock_timeout='3s' as $$
declare v_state text; v_fallback text; v_contact uuid; v_email text;
begin
 if new.direction='inbound' and session_user='hub_app_server' and new.provider_message_id like 'email:%' then
  begin
   perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
  exception when others then
   v_state:=sqlstate;
  end;
  if v_state is null then
   begin
    perform private.growth_inquiry(new.id);
   exception when others then
    v_state:=sqlstate;
   end;
  end if;
  if v_state is not null then
   begin
    select g.id,g.email into v_contact,v_email from private.communications c join private.growth_contacts g on g.email=lower(btrim(c.contact_email))
    where c.id=new.communication_id;
    if v_contact is not null then
     if coalesce((private.growth_reply_reading(new.body)->>'optOut')::boolean,false) then
      update private.growth_contacts set eligibility='opted_out',version=version+1 where id=v_contact;
      insert into private.email_suppressions(email_hash) values(encode(extensions.digest(v_email,'sha256'),'hex')) on conflict do nothing;
     end if;
     update private.growth_messages set status='cancelled' where contact_id=v_contact and status in ('draft','proposed');
    end if;
   exception when others then
    v_fallback:=sqlstate;
   end;
   begin
    insert into private.audit_events(action,entity_type,entity_id,metadata)
    values('growth.inquiry_failed','communication_message',new.id,
     jsonb_strip_nulls(jsonb_build_object('communicationId',new.communication_id,'sqlstate',v_state,'fallbackSqlstate',v_fallback)));
   exception when others then
    raise warning 'Growth capture skipped an inbound email (%, %)', v_state, coalesce(v_fallback,'-');
   end;
  end if;
 end if;
 return new;
end; $$;
revoke all on function private.growth_inbound_trigger() from public,anon,authenticated,service_role,hub_app_server;

do $$
declare r text;
begin
  if not exists (select 1 from pg_proc where oid = 'private.growth_inquiry(uuid)'::regprocedure and prosecdef
                   and proconfig @> array['search_path=""'] and prosrc like '%require_hub_app_server%' and prosrc like '%growth_reply_reading%')
     or not has_function_privilege('hub_app_server', 'private.growth_inquiry(uuid)', 'execute') then
    raise exception 'Reply capture does not read the sender''s own words' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_proc where oid = 'private.growth_inbound_trigger()'::regprocedure and prosecdef and prosrc like '%growth_reply_reading%')
     or not exists (select 1 from pg_trigger where tgname = 'growth_inbound' and tgrelid = 'private.communication_messages'::regclass and not tgisinternal) then
    raise exception 'The inbox fallback does not read a request to stop as capture does' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_proc where oid = 'private.growth_reply_reading(text)'::regprocedure and provolatile = 'i' and not prosecdef) then
    raise exception 'The reply reading must be pure' using errcode = '55000';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_function_privilege(r, 'private.growth_reply_reading(text)', 'execute') or has_function_privilege(r, 'private.growth_inbound_trigger()', 'execute')
       or (r <> 'hub_app_server' and has_function_privilege(r, 'private.growth_inquiry(uuid)', 'execute')) then
      raise exception 'Growth reply reading exposed to %', r using errcode = '55000';
    end if;
  end loop;
end $$;
