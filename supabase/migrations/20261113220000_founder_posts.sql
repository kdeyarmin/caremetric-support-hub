-- The founder's personal LinkedIn (owner decision 2026-11-13): with Settings → Social media → "Write posts for my LinkedIn profile" on,
-- the weekly social plan writes a few posts in the founder's voice. Each is a `social.founder_post` action the owner approves one by one:
-- the autonomy calendar never hands them over (no step names the kind, and the constraint below refuses an automatic approval). With a
-- member token saved on the LinkedIn connection card they publish to the founder's profile; without one they are emailed to copy and post.
-- Nothing here sends messages, connection requests or comments on other people's posts.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('social.founder_posts', 'flag'),
  ('social.founder_posts_per_week', 'number')
on conflict (key) do nothing;

do $$
declare v_kinds text[];
begin
  select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_kinds
  from pg_constraint c cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') m
  where c.conrelid = 'private.agent_actions'::regclass and c.conname = 'agent_actions_kind_check';
  if not v_kinds @> array['communication.reply', 'growth.message', 'social.post', 'creative.asset']
    or exists (select 1 from unnest(v_kinds) value where value !~ '^[a-z][a-z0-9_.]{1,60}$') then
    raise exception 'The agent action kinds could not be read' using errcode = '55000';
  end if;
  execute format('alter table private.agent_actions drop constraint agent_actions_kind_check, add constraint agent_actions_kind_check check (kind in (%s))',
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_kinds || array['social.founder_post']) as k) x));
end $$;

-- A founder post is the Social Media Manager's, names its week's slot, and is never approved automatically.
alter table private.agent_actions add constraint agent_actions_founder_post_check check (
  kind <> 'social.founder_post' or coalesce(agent_key = 'social_manager' and target_kind = 'social_item' and target_id ~ '^founder:[0-9]{4}-[0-9]{2}-[0-9]{2}:[1-5]$'
    and status <> 'auto_approved', false)) not valid;
alter table private.agent_actions validate constraint agent_actions_founder_post_check;
