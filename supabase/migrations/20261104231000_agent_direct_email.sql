-- A one-off email prepared by the signed-in portfolio owner. Nothing sends on creation.
-- The owner reviews the exact recipient, subject and body through the existing agent action queue.
-- A durable send reservation makes a repeated execution or a provider timeout non-retriable.
set local lock_timeout = '10s';

do $boundary$
declare v_kinds text[]; v_targets text[];
begin
  select coalesce(array_agg(distinct m[1]),array[]::text[]) into v_kinds
  from pg_constraint c cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''','g') m
  where c.conrelid='private.agent_actions'::regclass and c.conname='agent_actions_kind_check';
  select coalesce(array_agg(distinct m[1]),array[]::text[]) into v_targets
  from pg_constraint c cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''','g') m
  where c.conrelid='private.agent_actions'::regclass and c.conname='agent_actions_target_kind_check';
  if not v_kinds @> array['communication.reply','email.send','content.publish']
     or not v_targets @> array['communication','billing_account','content_item']
     or exists (select 1 from unnest(v_kinds || v_targets) x where x !~ '^[a-z][a-z0-9_.]{1,60}$') then
    raise exception 'Review the existing agent action kinds before adding direct mail.' using errcode='55000';
  end if;
  execute format('alter table private.agent_actions drop constraint agent_actions_kind_check, add constraint agent_actions_kind_check check(kind in (%s))',
    (select string_agg(quote_literal(x),', ' order by x) from (select distinct unnest(v_kinds || array['email.direct']) x) s));
  execute format('alter table private.agent_actions drop constraint agent_actions_target_kind_check, add constraint agent_actions_target_kind_check check(target_kind in (%s))',
    (select string_agg(quote_literal(x),', ' order by x) from (select distinct unnest(v_targets || array['external_email']) x) s));
end;
$boundary$;

alter table private.agent_actions add constraint agent_actions_direct_email_shape_check check (
  kind <> 'email.direct' or coalesce(
    agent_key='chief_of_staff' and task_id is null and target_kind='external_email'
    and target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and input=jsonb_build_object('emailId',target_id)
    and status <> 'auto_approved', false));

create table private.agent_direct_emails (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  action_id uuid not null unique references private.agent_actions(id) on delete restrict,
  recipient text not null check (char_length(recipient) between 3 and 200 and recipient=lower(recipient)
    and recipient ~ '^[a-z0-9_''+-]+(\\.[a-z0-9_''+-]+)*@[a-z0-9-]+(\\.[a-z0-9-]+)+$'),
  subject text not null check (char_length(subject) between 3 and 150 and subject !~ '[[:cntrl:]]'),
  body text not null check (char_length(body) between 10 and 3800),
  requested_by uuid not null references auth.users(id) on delete restrict,
  status text not null default 'proposed' check(status in ('proposed','sending','sent','failed','unknown')),
  attempted_at timestamptz,
  finished_at timestamptz,
  provider_message_id text check (char_length(provider_message_id)<=200),
  created_at timestamptz not null default now(),
  check ((status='proposed' and attempted_at is null and finished_at is null)
     or (status='sending' and attempted_at is not null and finished_at is null)
     or (status in ('sent','failed','unknown') and attempted_at is not null and finished_at is not null))
);
alter table private.agent_direct_emails enable row level security;
revoke all on private.agent_direct_emails from public,anon,authenticated,service_role,hub_app_server;

-- Only an owner with the current command session may prepare a message. A replay of the
-- exact request key is safe; changed wording under the same key is refused.
create function hub.prepare_agent_direct_email(p_recipient text,p_subject text,p_body text,p_request_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_actor jsonb;
  v_recipient text := lower(btrim(p_recipient));
  v_subject text := btrim(p_subject);
  v_body text := btrim(p_body);
  v_previous private.agent_direct_emails%rowtype;
  v_id uuid := gen_random_uuid();
  v_action uuid;
begin
  v_actor:=hub.authorize_app_command();
  if p_request_key is null or v_recipient is null or char_length(v_recipient) not between 3 and 200
     or v_recipient !~ '^[a-z0-9_''+-]+(\\.[a-z0-9_''+-]+)*@[a-z0-9-]+(\\.[a-z0-9-]+)+$'
     or v_subject is null or char_length(v_subject) not between 3 and 150 or v_subject ~ '[[:cntrl:]]'
     or v_body is null or char_length(v_body) not between 10 and 3800 then
    raise exception 'Enter one email address, a subject and message without patient information.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('agent-direct-email:'||p_request_key::text,0));
  select * into v_previous from private.agent_direct_emails where request_key=p_request_key;
  if found then
    if v_previous.recipient is distinct from v_recipient
       or v_previous.subject is distinct from v_subject
       or v_previous.body is distinct from v_body
       or v_previous.requested_by is distinct from (v_actor->>'user_id')::uuid then
      raise exception 'This email request changed. Start a new draft.' using errcode='22023';
    end if;
    return jsonb_build_object('id',v_previous.id,'actionId',v_previous.action_id,'status',v_previous.status);
  end if;
  insert into private.agent_actions(agent_key,kind,target_kind,target_id,preview,input,status)
  values ('chief_of_staff','email.direct','external_email',v_id::text,
    'To: '||v_recipient||E'\nSubject: '||v_subject||E'\n\n'||v_body,
    jsonb_build_object('emailId',v_id::text),'proposed') returning id into v_action;
  insert into private.agent_direct_emails(id,request_key,action_id,recipient,subject,body,requested_by)
  values(v_id,p_request_key,v_action,v_recipient,v_subject,v_body,(v_actor->>'user_id')::uuid);
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
  values((v_actor->>'user_id')::uuid,'agent.email.prepared','agent_action',v_action,jsonb_build_object('kind','email.direct'));
  return jsonb_build_object('id',v_id,'actionId',v_action,'status','proposed');
end;
$$;
revoke all on function hub.prepare_agent_direct_email(text,text,text,uuid) from public,anon,authenticated,service_role,hub_app_server;
grant execute on function hub.prepare_agent_direct_email(text,text,text,uuid) to authenticated;

-- Reservation comes before the network call. A crash or timeout leaves a 'sending' row;
-- replay never calls the provider twice, even if action maintenance resets its execution.
create function private.agent_direct_email_begin_send(p_action uuid,p_execution integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_action private.agent_actions%rowtype; v_mail private.agent_direct_emails%rowtype;
begin
  perform private.require_hub_app_server();
  select * into v_action from private.agent_actions where id=p_action for update;
  if not found or v_action.kind<>'email.direct' then
    raise exception 'Unknown owner email.' using errcode='P0002';
  end if;
  if p_execution is null or v_action.executions<>p_execution or v_action.status<>'executing' then
    raise exception 'This email is not being sent.' using errcode='55000';
  end if;
  if v_action.decided_by is null or v_action.decided_at is null then
    return jsonb_build_object('state','approval_required');
  end if;
  select * into v_mail from private.agent_direct_emails where action_id=p_action for update;
  if not found then raise exception 'Owner email has no send record.' using errcode='55000'; end if;
  if v_mail.status<>'proposed' then
    return jsonb_build_object('state','recorded','status',v_mail.status);
  end if;
  if v_action.input is distinct from jsonb_build_object('emailId',v_mail.id::text)
     or v_action.preview is distinct from ('To: '||v_mail.recipient||E'\nSubject: '||v_mail.subject||E'\n\n'||v_mail.body) then
    return jsonb_build_object('state','wording_changed');
  end if;
  update private.agent_direct_emails set status='sending',attempted_at=now()
  where id=v_mail.id;
  return jsonb_build_object('state','ready','to',v_mail.recipient,'subject',v_mail.subject,'body',v_mail.body);
end;
$$;
revoke all on function private.agent_direct_email_begin_send(uuid,integer) from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.agent_direct_email_begin_send(uuid,integer) to hub_app_server;

create function private.agent_direct_email_finish_send(p_action uuid,p_execution integer,p_delivery text,p_provider_id text) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_owner uuid; v_id uuid;
begin
  perform private.require_hub_app_server();
  if p_delivery not in ('sent','failed','unknown') or p_delivery is null
    or (p_provider_id is not null and char_length(p_provider_id)>200) then
    raise exception 'Invalid delivery outcome.' using errcode='22023';
  end if;
  select e.id,e.requested_by into v_id,v_owner
  from private.agent_actions a join private.agent_direct_emails e on e.action_id=a.id
  where a.id=p_action and a.kind='email.direct' and a.status='executing'
    and a.executions=p_execution and e.status='sending'
  for update of a,e;
  if v_id is null then return false; end if;
  update private.agent_direct_emails
    set status=p_delivery,finished_at=now(),provider_message_id=p_provider_id
    where id=v_id and status='sending';
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
  values(v_owner,'agent.email.'||p_delivery,'agent_action',p_action,jsonb_build_object('kind','email.direct'));
  return true;
end;
$$;
revoke all on function private.agent_direct_email_finish_send(uuid,integer,text,text) from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.agent_direct_email_finish_send(uuid,integer,text,text) to hub_app_server;
