with lesson_catalog (content_key, video_titles) as (
  values
    (
      'penntrain.course.pa-pch-diabetes-annual',
      jsonb_build_array(
        'Diabetes, insulin, and what your job actually is',
        'Checking a blood sugar, and reading one that does not fit',
        'Low blood sugar: the emergency in this course',
        'High blood sugar, dehydration, and when it stops waiting',
        'The insulins, and the two things that multiply an error',
        'Storage, and damage that does not show',
        'Reading the order and the MAR',
        'Drawing up a dose, and the line that is worth two',
        'Insulin pens, and the one that belongs to one person',
        'Giving the injection, start to finish',
        'When something goes wrong',
        'Four decisions, and the one thing to carry out'
      )
    ),
    (
      'penntrain.course.pa-dhs-standalone-emergency-prep',
      jsonb_build_array(
        'The emergencies that do not sound an alarm',
        'The first sixty seconds',
        'Staying in your role, including when something else happens',
        'Shelter or evacuate, and what moving costs',
        'Power, heat, cold, water, weather, and a missing resident',
        'What leaves when the power leaves',
        'The residents this is hardest on',
        'The count, the chain, the record, and the drill',
        'When it does not end in an hour',
        'What to carry out of this course'
      )
    ),
    (
      'penntrain.course.pa-dhs-standalone-falls-prevention',
      jsonb_build_array(
        'Why a fall changes a life faster than a diagnosis',
        'Medications, and the week after a change',
        'The change that arrives before the fall',
        'Baseline risk and the plan on the wall',
        'The fifteen seconds before you leave',
        'The room, the bathroom, and the call bell',
        'Setting up a transfer, and the line you do not cross',
        'You walk in and somebody is on the floor',
        'Who stays down, and what you write',
        'What to carry out of this course'
      )
    ),
    (
      'penntrain.course.pa-dhs-standalone-infection-control',
      jsonb_build_array(
        'Why a little bit sick is a different thing in your building',
        'The five rides an infection can take',
        'When hands get cleaned, and the spots they miss',
        'The alcohol exception, and the order that keeps you clean',
        'How protective equipment quietly stops working',
        'The two-second wipe, and what contact time actually means',
        'Equipment that travels, and why everybody gets the same care',
        'What the sign on the door is asking for',
        'Immobility, atypical presentation, and coming to work sick',
        'Two is a pattern, and what to carry out of this hour'
      )
    ),
    (
      'penntrain.course.pa-dhs-standalone-med-self-admin',
      jsonb_build_array(
        'The line between supporting and administering',
        'What self-administration actually means in Pennsylvania',
        'The five rights, and the timing decision that is not yours',
        'The ones that actually happen, and how they start',
        'The absolute rules, and the crushing question',
        'Refusals, and the question worth asking first',
        'What these medications actually do',
        'The one that will not wait, and errors',
        'What you notice, which matters more than the pills',
        'The bottle from outside, and what to carry out of this course'
      )
    ),
    (
      'penntrain.course.pa-orient-new-employee-pch-alf',
      jsonb_build_array(
        'Welcome to CareBase: why your first days matter',
        'Recognizing and reporting abuse, neglect, and exploitation',
        'Medications, boundaries, and asking for help'
      )
    ),
    (
      'penntrain.course.pa-dhs-standalone-safe-management',
      jsonb_build_array(
        'Behavior is communication, and it is almost never about you',
        'What escalation looks like before anyone raises a voice',
        'Cannot, not will not',
        'The thirty seconds before the task starts',
        'What actually works once it has started',
        'The sentences that help, and the ones that do not',
        'The tasks this goes wrong in, and how to restructure them',
        'Restraint, coercion, and the line that does not move',
        'When you are the one escalating',
        'What you write down, and what to carry out of this course'
      )
    )
), source_revisions as (
  select
    item.id as item_id,
    lesson.video_titles,
    base.locale,
    base.product_overlay_id,
    base.title,
    base.summary,
    base.body_markdown,
    base.body_text,
    base.variables,
    base.created_by,
    base.approved_by,
    (
      select coalesce(max(existing.revision_no), 0) + 1
      from hub.content_revisions existing
      where existing.item_id = item.id
    ) as next_revision_no
  from lesson_catalog lesson
  join hub.content_items item
    on item.content_key = lesson.content_key
   and item.kind = 'course'
  join lateral (
    select revision.*
    from hub.content_publications publication
    join hub.content_revisions revision
      on revision.id = publication.revision_id
     and revision.item_id = publication.item_id
    where publication.item_id = item.id
    order by revision.revision_no desc, revision.id
    limit 1
  ) base on true
)
insert into hub.content_revisions (
  id,
  item_id,
  revision_no,
  locale,
  product_overlay_id,
  title,
  summary,
  body_markdown,
  body_text,
  variables,
  source_hash,
  source_version,
  review_state,
  created_by,
  approved_by,
  created_at,
  approved_at
)
select
  gen_random_uuid(),
  source.item_id,
  source.next_revision_no,
  source.locale,
  source.product_overlay_id,
  source.title,
  source.summary,
  source.body_markdown,
  source.body_text,
  jsonb_set(coalesce(source.variables, '{}'::jsonb), '{video_titles}', source.video_titles, true),
  encode(extensions.digest(source.video_titles::text, 'sha256'), 'hex'),
  'carebase-video-lessons-2026-09-07',
  'approved',
  source.created_by,
  source.approved_by,
  now(),
  now()
from source_revisions source
where not exists (
  select 1
  from hub.content_revisions existing
  where existing.item_id = source.item_id
    and existing.source_version = 'carebase-video-lessons-2026-09-07'
);

update hub.content_publications publication
set revision_id = lesson_revision.id
from hub.content_revisions lesson_revision
where lesson_revision.item_id = publication.item_id
  and lesson_revision.source_version = 'carebase-video-lessons-2026-09-07'
  and publication.revision_id is distinct from lesson_revision.id;

drop function if exists hub.list_published_content();

create function hub.list_published_content()
returns table (
  id uuid,
  content_key text,
  kind hub.content_kind,
  title text,
  summary text,
  body_markdown text,
  status hub.content_status,
  access_level hub.access_level,
  product_ids uuid[],
  audience text[],
  locale text,
  revision_no integer,
  source_system hub.content_source,
  route_pattern text,
  video_status text,
  course_launch_path text,
  placements jsonb,
  content_category text,
  course_duration_minutes integer,
  course_video_count integer,
  course_video_titles text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with accessible_publications as (
    select
      publication.id as publication_id,
      publication.item_id,
      publication.revision_id,
      publication.product_id,
      publication.audience,
      publication.route_pattern
    from hub.content_publications publication
    join hub.content_items item
      on item.id = publication.item_id
    join hub.content_revisions revision
      on revision.id = publication.revision_id
     and revision.item_id = publication.item_id
    join hub.products product
      on product.id = publication.product_id
    where item.status = 'published'
      and revision.review_state = 'approved'
      and product.status <> 'retired'
      and product.support_enabled
      and (revision.product_overlay_id is null or revision.product_overlay_id = publication.product_id)
      and publication.published_at <= now()
      and (publication.expires_at is null or publication.expires_at > now())
      and private.can_access_content_publication(
        publication.item_id,
        publication.revision_id,
        publication.product_id
      )
  ),
  grouped_publications as (
    select
      publication.item_id,
      publication.revision_id,
      array_agg(distinct publication.product_id) as product_ids,
      coalesce(
        (
          select array_agg(distinct audience_value order by audience_value)
          from accessible_publications audience_publication
          cross join lateral unnest(audience_publication.audience) as audience_value
          where audience_publication.item_id = publication.item_id
            and audience_publication.revision_id = publication.revision_id
        ),
        array[]::text[]
      ) as audience,
      case
        when count(distinct publication.route_pattern)
          filter (where publication.route_pattern is not null) <= 1
        then min(publication.route_pattern)
        else null
      end as route_pattern,
      jsonb_agg(
        jsonb_build_object(
          'product_id', publication.product_id,
          'audience', publication.audience,
          'route_pattern', publication.route_pattern
        )
        order by publication.product_id
      ) as placements
    from accessible_publications publication
    group by publication.item_id, publication.revision_id
  )
  select
    revision.id,
    item.content_key,
    item.kind,
    revision.title,
    revision.summary,
    revision.body_markdown,
    item.status,
    item.access_level,
    grouped.product_ids,
    grouped.audience,
    revision.locale,
    revision.revision_no,
    item.source_system,
    grouped.route_pattern,
    media.render_status as video_status,
    course.launch_path as course_launch_path,
    grouped.placements,
    nullif(btrim(revision.variables ->> 'category'), '') as content_category,
    course.duration_minutes as course_duration_minutes,
    case
      when coalesce(revision.variables ->> 'video_count', '') ~ '^[0-9]{1,6}$'
      then (revision.variables ->> 'video_count')::integer
      else null
    end as course_video_count,
    case
      when jsonb_typeof(revision.variables -> 'video_titles') = 'array'
      then array(
        select left(video_title.value, 180)
        from jsonb_array_elements_text(revision.variables -> 'video_titles')
          with ordinality as video_title(value, position)
        where video_title.position <= 100
        order by video_title.position
      )
      else array[]::text[]
    end as course_video_titles
  from grouped_publications grouped
  join hub.content_items item
    on item.id = grouped.item_id
  join hub.content_revisions revision
    on revision.id = grouped.revision_id
  left join lateral (
    select asset.render_status
    from hub.media_assets asset
    where asset.content_item_id = grouped.item_id
      and asset.revision_id = grouped.revision_id
      and private.can_view_media_asset(asset.id)
      and exists (
        select 1
        from accessible_publications publication
        where publication.item_id = asset.content_item_id
          and publication.revision_id = asset.revision_id
          and (asset.product_id is null or asset.product_id = publication.product_id)
      )
    order by
      (asset.published_at is not null) desc,
      asset.published_at desc nulls last,
      case asset.render_status
        when 'ready' then 1
        when 'review' then 2
        when 'rendering' then 3
        when 'failed' then 4
        when 'retired' then 5
        else 6
      end,
      asset.created_at desc,
      asset.id desc
    limit 1
  ) media on true
  left join hub.course_links course
    on course.content_item_id = item.id
  order by revision.title;
$$;

revoke all on function hub.list_published_content()
from public, anon, authenticated;
grant execute on function hub.list_published_content()
to anon, authenticated;
