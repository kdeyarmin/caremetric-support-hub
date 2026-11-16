-- Record why an address check got no answer, and what the reader thought of each first email (owner decision 2026-11-16).
--
-- Why. On the first day of checking addresses before the first email (20261116100000_growth_address_check.sql), 25 of the 47
-- addresses asked about came back unanswered, and each such address holds its first email about 32 hours before it goes anyway. The
-- checker knows why a server gave no answer (a temporary refusal, a policy block, a dropped connection) but only the result was kept,
-- so nobody can tell whether asking again ever helps. And the reader who reviews each briefed first email (server/growth/draft.mjs)
-- scored all four of the first day's 2 or 3 of 5, each was rewritten around its weakest sentence, and none scored higher; only the
-- one number reached its arms, so nobody can see what the reader objects to. Both are recorded from now on, to decide after about
-- twenty first emails whether the retries and the rewrite are worth keeping. Nothing here changes what is checked, written or sent.
--
-- 1. private.growth_contacts.mailbox_reason: why the most recent check that got no answer got none. Kept when a later check answers,
--    so an address answered on a retry shows what the retry overcame. One of: temporary (the server said try later), blocked (a policy
--    or reputation refusal), refused (the server would not talk), sender_refused (it refused the null sender), unexpected (an answer
--    that is neither yes nor no), dropped (the connection ended or timed out), no_mail (the domain has no mail server), invalid (the
--    address or domain could not be asked), unreachable (no mail host answered) or error (the checker failed). Never the server's words.
-- 2. private.growth_mailbox_record(uuid, text, text): the two-argument function, unchanged, then the reason. Hub server only.
-- 3. private.growth_message_reviews: one row per first email the reader reviewed, with the reader's four scores (specific, relevant,
--    clear ask, would reply; 1 to 5) and the sentence that most made them stop reading, for the first read and for the rewrite's read
--    when there was one, and what became of the rewrite: not_needed (scored 4 or more), no_time (the minute was spent), no_answer,
--    failed_checks (with the check's code), unread (the reader gave no second score), scored_lower (the first was kept) or kept.
--    Closed to every role; written by private.growth_review_record(uuid, jsonb), Hub server only. The sentence is one of the email's
--    own, which the message already holds.
--
-- 20261117160100_growth_diagnostics_contract.sql declares platform.agents.growth-diagnostics.v1, and the server records either only
-- once it is declared.
set local lock_timeout = '10s';

alter table private.growth_contacts add column if not exists mailbox_reason text
  check (mailbox_reason in ('temporary', 'blocked', 'refused', 'sender_refused', 'unexpected', 'dropped', 'no_mail', 'invalid', 'unreachable', 'error'));

-- Server: the mail server's answer for one address, and why it gave none. The same as the two-argument function, which it calls.
create or replace function private.growth_mailbox_record(p_contact uuid, p_result text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_saved jsonb; begin
 perform private.require_hub_app_server();
 if p_reason is not null and p_reason not in ('temporary', 'blocked', 'refused', 'sender_refused', 'unexpected', 'dropped', 'no_mail', 'invalid', 'unreachable', 'error')
   then raise exception 'Invalid reason' using errcode = '22023'; end if;
 v_saved := private.growth_mailbox_record(p_contact, p_result);
 if p_result in ('unknown', 'unreachable') then
  update private.growth_contacts set mailbox_reason = coalesce(p_reason, case when p_result = 'unreachable' then 'unreachable' else 'error' end)
   where id = p_contact;
 end if;
 return v_saved || jsonb_build_object('reason', case when p_result in ('unknown', 'unreachable')
   then coalesce(p_reason, case when p_result = 'unreachable' then 'unreachable' else 'error' end) end);
end; $$;
revoke all on function private.growth_mailbox_record(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function private.growth_mailbox_record(uuid, text, text) to hub_app_server;

create table if not exists private.growth_message_reviews (
  message_id uuid primary key references private.growth_messages(id) on delete cascade,
  prompt_version text not null check (prompt_version ~ '^[a-z0-9._-]{1,40}$'),
  first_read jsonb not null,
  rewrite_read jsonb,
  rewrite text not null check (rewrite in ('not_needed', 'no_time', 'no_answer', 'failed_checks', 'unread', 'scored_lower', 'kept')),
  rewrite_problem text check (rewrite_problem ~ '^[a-z_]{1,40}$'),
  created_at timestamptz not null default now(),
  check ((rewrite_read is not null) = (rewrite in ('scored_lower', 'kept'))),
  check ((rewrite_problem is not null) = (rewrite = 'failed_checks'))
);
alter table private.growth_message_reviews enable row level security;
revoke all on private.growth_message_reviews from public, anon, authenticated, service_role, hub_app_server;

-- One read: four whole-number scores from 1 to 5 and the weakest sentence, at most 400 characters. Nothing else.
create or replace function private.growth_review_read_ok(p_read jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_read) = 'object'
     and (select count(*) from jsonb_object_keys(p_read)) = 5
     and coalesce((select bool_and(jsonb_typeof(p_read -> k) = 'number' and (p_read ->> k) ~ '^[1-5]$')
                     from unnest(array['specific', 'relevant', 'clearAsk', 'wouldReply']) k), false)
     and jsonb_typeof(p_read -> 'weakest') = 'string' and length(p_read ->> 'weakest') <= 400;
$$;
revoke all on function private.growth_review_read_ok(jsonb) from public, anon, authenticated, service_role, hub_app_server;

-- Server: the reader's review of one first email, once. Returns whether it was recorded.
create or replace function private.growth_review_record(p_message uuid, p_review jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_first jsonb; v_second jsonb; v_outcome text; v_problem text; v_version text; begin
 perform private.require_hub_app_server();
 if jsonb_typeof(p_review) is distinct from 'object' then raise exception 'Invalid review' using errcode = '22023'; end if;
 v_first := p_review -> 'first';
 v_second := nullif(p_review -> 'rewrite', 'null'::jsonb);
 v_outcome := p_review ->> 'outcome';
 v_problem := p_review ->> 'problem';
 v_version := p_review ->> 'promptVersion';
 if not coalesce(private.growth_review_read_ok(v_first), false)
   or (v_second is not null and not coalesce(private.growth_review_read_ok(v_second), false))
   or v_outcome is null or v_outcome not in ('not_needed', 'no_time', 'no_answer', 'failed_checks', 'unread', 'scored_lower', 'kept')
   or (v_second is not null) <> (v_outcome in ('scored_lower', 'kept'))
   or (v_problem is not null) <> (v_outcome = 'failed_checks') or (v_problem is not null and v_problem !~ '^[a-z_]{1,40}$')
   or v_version is null or v_version !~ '^[a-z0-9._-]{1,40}$' then
  raise exception 'Invalid review' using errcode = '22023';
 end if;
 if not exists (select 1 from private.growth_messages where id = p_message) then raise exception 'Unknown message' using errcode = '22023'; end if;
 insert into private.growth_message_reviews (message_id, prompt_version, first_read, rewrite_read, rewrite, rewrite_problem)
 values (p_message, v_version, v_first, v_second, v_outcome, v_problem)
 on conflict (message_id) do nothing;
 return found;
end; $$;
revoke all on function private.growth_review_record(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function private.growth_review_record(uuid, jsonb) to hub_app_server;
