-- CareMetric Healthcare Advisors joins central administration and support.
-- Advisors is a consulting practice: a public website plus a private
-- consultation inbox. It has no software subscriptions, customer accounts,
-- learners or patient workflows, so only its consultation requests are
-- administered centrally and no course placements are created.
insert into hub.products (id, slug, name, description, status, color, support_enabled)
values (
  '00000000-0000-4000-8000-000000000007',
  'advisors',
  'CareMetric Healthcare Advisors',
  'Healthcare and senior-care advisory consultations, acquisition support, and staff education.',
  'active',
  '#07356F',
  true
)
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  status = excluded.status,
  color = excluded.color,
  support_enabled = excluded.support_enabled;

-- The Advisors administration bridge consumes only its own one-use SMS audience.
-- Preserve every existing application, command, learning, publication and media audience.
alter table private.app_delegations drop constraint app_delegations_audience_check;
alter table private.app_delegations add constraint app_delegations_audience_check
  check(audience in ('carebase','breathe','caremetric-emr','pennsync','caremetric-go','intel','advisors',
    'carebase.command','carebase.learning','publication','media'));

-- Reuse only the reviewed public safety article. The software onboarding
-- article and the course catalog do not apply to a consulting practice.
insert into hub.content_publications (item_id, revision_id, product_id, audience, route_pattern, published_at)
select publication.item_id, publication.revision_id, advisors.id, publication.audience, null, publication.published_at
from hub.content_publications publication
join hub.products carebase on carebase.id = publication.product_id and carebase.slug = 'carebase'
join hub.products advisors on advisors.slug = 'advisors'
join hub.content_items item on item.id = publication.item_id
where item.content_key = 'support.protect-patient-information'
on conflict (item_id, product_id) do update set
  revision_id = excluded.revision_id,
  audience = excluded.audience,
  route_pattern = excluded.route_pattern,
  published_at = excluded.published_at,
  expires_at = null
where excluded.published_at >= hub.content_publications.published_at;

-- The eleven answers already published at https://caremetricadvisors.com/faq,
-- copied verbatim from kdeyarmin/advisors@37afa7a884dc70f52d1134a7a27927ffee847373
-- (site-content.mjs, export faqs). Public business information only; no
-- inquiry, contact or client record is copied.
with source_rows as (
  select *
  from jsonb_to_recordset($faq$[{"slug":"what-kinds-of-organizations-do-you-work-with","title":"What kinds of organizations do you work with?","answer":"CareMetric focuses on healthcare and senior-care organizations, including home health, hospice, personal care, assisted living, skilled nursing and related healthcare service businesses, as well as owners and acquisition teams.","sort_order":1},{"slug":"how-does-an-engagement-begin","title":"How does an engagement begin?","answer":"It starts with a conversation about the decision, problem, or opportunity you are working through. CareMetric then outlines a proposed scope, approach, deliverables, and timeline so expectations are clear before any work begins.","sort_order":2},{"slug":"can-an-engagement-focus-on-one-specific-problem","title":"Can an engagement focus on one specific problem?","answer":"Yes. Work can be narrowly scoped around a defined issue or expanded into a broader organizational assessment.","sort_order":3},{"slug":"how-are-engagements-structured","title":"How are engagements structured?","answer":"Engagements are structured around the need: a focused project, a comprehensive review, an acquisition engagement, or ongoing advisory support. Fees reflect the scope and duration of the work and are set out in a written proposal before an engagement starts.","sort_order":4},{"slug":"do-you-provide-implementation-support","title":"Do you provide implementation support?","answer":"Yes. Depending on scope, CareMetric can move beyond recommendations into policies, workflows, education, technology, dashboards, project management, and follow-up measurement.","sort_order":5},{"slug":"do-you-work-on-site-or-remotely","title":"Do you work on-site or remotely?","answer":"Both. Analysis, planning, reporting, and follow-up are often handled remotely. On-site work is arranged when the engagement calls for it, such as operational assessments, staff education, or implementation support.","sort_order":6},{"slug":"can-you-develop-custom-software-or-automation","title":"Can you develop custom software or automation?","answer":"Yes. Technology work can include workflow assessment, automation, system design, integrations, dashboards, implementation, and custom healthcare software development.","sort_order":7},{"slug":"how-does-the-software-portfolio-relate-to-the","title":"How does the software portfolio relate to the consulting work?","answer":"The CareMetric software portfolio is developed by Dr. Deyarmin alongside the advisory practice. Advisory engagements do not require any CareMetric software; a product is discussed only when it genuinely fits the workflow and the organization wants to evaluate it.","sort_order":8},{"slug":"do-you-provide-acquisition-due-diligence","title":"Do you provide acquisition due diligence?","answer":"CareMetric can provide healthcare-focused research and diligence support. Legal, accounting, valuation, tax, coding, and other specialized reviews should be completed by appropriately qualified professionals.","sort_order":9},{"slug":"how-is-confidential-information-handled","title":"How is confidential information handled?","answer":"Client materials are used only for the engagement, shared only with the people who need them, and handled under the confidentiality terms agreed before work begins. If an engagement requires access to protected records, that access is arranged under the appropriate agreements and safeguards rather than through this website.","sort_order":10},{"slug":"can-i-submit-patient-information-through-this-site","title":"Can I submit patient information through this site?","answer":"No. The public consultation form is for business inquiries only and should not contain patient information or other protected health information.","sort_order":11}]$faq$::jsonb) as row_data(
    slug text,
    title text,
    answer text,
    sort_order integer
  )
),
upserted_items as (
  insert into hub.content_items (
    id, content_key, kind, status, access_level, owner_product_id, owner_team, source_system
  )
  select
    md5('advisors-faq-item:' || slug)::uuid,
    'advisors.faq.' || slug,
    'article',
    'published',
    'public',
    (select id from hub.products where slug = 'advisors'),
    'CareMetric Healthcare Advisors',
    'legacy'
  from source_rows
  on conflict (id) do update set
    content_key = excluded.content_key,
    status = excluded.status,
    access_level = excluded.access_level,
    owner_product_id = excluded.owner_product_id,
    owner_team = excluded.owner_team,
    source_system = excluded.source_system,
    retired_at = null,
    updated_at = now()
  returning id
),
upserted_revisions as (
  insert into hub.content_revisions (
    id, item_id, revision_no, locale, title, summary, body_markdown, body_text,
    variables, source_hash, source_version, review_state, approved_at
  )
  select
    md5('advisors-faq-revision:' || slug)::uuid,
    md5('advisors-faq-item:' || slug)::uuid,
    1,
    'en-US',
    title,
    answer,
    answer,
    answer,
    jsonb_build_object('category', 'Frequently asked questions', 'article_type', 'faq', 'sort_order', sort_order),
    encode(sha256(convert_to(title || E'\n' || answer, 'UTF8')), 'hex'),
    'advisors@37afa7a884dc70f52d1134a7a27927ffee847373:site-content.mjs#faqs',
    'approved',
    now()
  from source_rows
  on conflict (id) do nothing
  returning id
)
insert into hub.content_publications (item_id, revision_id, product_id, audience, route_pattern)
select
  md5('advisors-faq-item:' || source_rows.slug)::uuid,
  md5('advisors-faq-revision:' || source_rows.slug)::uuid,
  advisors.id,
  array['all']::text[],
  null
from source_rows
join hub.products advisors on advisors.slug = 'advisors'
on conflict (item_id, product_id) do nothing;
