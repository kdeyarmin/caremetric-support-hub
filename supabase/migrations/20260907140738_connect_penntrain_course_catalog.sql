update hub.content_revisions
set
  title = 'CareMetric CareBase course catalog',
  summary = 'Open the central CareMetric course catalog for governed training, assignments, quizzes, and certificates.',
  body_markdown = 'Courses are maintained once in CareMetric CareBase and can be assigned across supported organizations. Sign in to browse the current governed catalog.',
  body_text = 'Courses are maintained once in CareMetric CareBase and can be assigned across supported organizations. Sign in to browse the current governed catalog.',
  source_version = 'PennTrain:e4737ac86af1ccdcb734cc60389730674e6c7a98'
where id = '30000000-0000-4000-8000-000000000004';

update hub.course_links
set
  penntrain_course_id = 'catalog:caremetric-carebase',
  source_version = 'PennTrain:e4737ac86af1ccdcb734cc60389730674e6c7a98',
  launch_path = '/app/courses',
  duration_minutes = null,
  level = null,
  objectives = array[
    'Browse governed CareMetric training',
    'Assign courses from the central catalog',
    'Track quizzes and certificates in CareMetric CareBase'
  ]::text[],
  source_updated_at = now(),
  updated_at = now()
where content_item_id = '20000000-0000-4000-8000-000000000004';
