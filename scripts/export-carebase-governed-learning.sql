-- READ ONLY. Run as an authorized CareBase catalog operator. This result contains
-- answer keys and authored course/provider metadata: keep it private, never commit it.
-- One SQL statement gives a consistent snapshot. No asset bytes or learner/account/history
-- rows are exported. Native immutable media projection contains IDs and digests only.
-- Video URLs become locator hashes. Authored JSON is retained,
-- but the complete export fails closed on recognized credential or storage fields.
-- An authorized operator must still review authored material for private data.
-- A hash identifies the exact PostgreSQL JSONB serialization, including mutable policy
-- and publication state. Version UUID alone cannot identify a policy revision.
with snapshots as (
  select c.id, jsonb_build_object(
    'contract','carebase.course.v1','sourceCourseId',c.id,'sourceVersionId',v.id,
    'sourceVersionNumber',v.version_number,'publicationState',c.status,'sourceVersionState',v.status,
    'course',jsonb_build_object('title',c.title,'description',c.description,'category',c.category,
      'estimatedDurationMinutes',c.estimated_duration_minutes,'catalogCode',c.catalog_code,
      'recurrenceIntervalDays',c.recurrence_interval_days,'legacyTrainingTypeId',c.training_type_id,
      'renewalTrainingTypeId',c.renewal_training_type_id,'creditedDurationCheckExempt',c.credited_duration_check_exempt),
    'version',jsonb_build_object('title',v.title,'description',v.description,'label',v.version_label,
      'contentStandard',v.content_standard,'creditedDurationRationale',v.credited_duration_rationale,
      'aiGenerated',v.ai_generated,'aiReviewedAt',v.ai_reviewed_at),
    'blocks',coalesce((select jsonb_agg(jsonb_build_object(
      'id',b.id,'type',b.block_type,'sortOrder',b.sort_order,'title',b.title,'body',b.body,
      'documentId',b.document_id,'videoLocatorSha256',case when b.video_url is null then null
        else encode(extensions.digest(b.video_url,'sha256'),'hex') end,
      'quiz',(select jsonb_build_object('id',q.id,'title',q.title,'passingScore',q.passing_score_percent,
        'maxAttempts',q.max_attempts,'kind',q.quiz_kind,'shuffleQuestions',q.shuffle_questions,
        'shuffleAnswers',q.shuffle_answers,'revealsAnswersAfterAttempt',q.reveals_answers_after_attempt,
        'questions',coalesce((select jsonb_agg(jsonb_build_object('id',qq.id,'sortOrder',qq.sort_order,
          'prompt',qq.question_text,'type',qq.question_type,'points',qq.points,'topicCode',qq.topic_code,
          'topicLabel',qq.topic_label,'explanation',(select e.explanation from public.quiz_question_explanations e
            where e.question_id=qq.id and e.organization_id is null),
          'options',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'sortOrder',a.sort_order,
            'text',a.answer_text,'correct',a.is_correct) order by a.sort_order,a.id)
            from public.quiz_answers a where a.question_id=qq.id and a.organization_id is null),'[]'::jsonb)
        ) order by qq.sort_order,qq.id) from public.quiz_questions qq
        where qq.quiz_id=q.id and qq.organization_id is null),'[]'::jsonb))
      from public.quizzes q where q.course_block_id=b.id and q.organization_id is null)
    ) || case when b.media_asset_id is null then '{}'::jsonb else jsonb_build_object('mediaAsset',app_private.course_media_asset_projection(b.media_asset_id)) end order by b.sort_order,b.id) from public.course_blocks b
      where b.course_version_id=v.id and b.organization_id is null),'[]'::jsonb),
    'credits',coalesce((select jsonb_agg(jsonb_build_object('id',cc.id,'trainingTypeId',cc.training_type_id,
      'topicCode',cc.topic_code,'creditHours',cc.credit_hours::text,'mode',cc.credit_mode,
      'citationNote',cc.citation_note,'active',cc.is_active) order by cc.id)
      from public.course_compliance_credits cc where cc.course_id=c.id and cc.course_version_id=v.id),'[]'::jsonb),
    'provider',(select jsonb_build_object('id',p.id,'fullName',p.provider_full_name,'professionalTitle',p.professional_title,
      'credential',p.credential,'credentialNumber',p.credential_number,'credentialIssuingOrganization',p.credential_issuing_organization,
      'credentialExpiresOn',p.credential_expires_on,'courseAuthor',p.course_author,'signatureName',p.provider_signature_name,
      'signatureRecordedAt',p.provider_signature_recorded_at,'contentVersion',p.content_version,
      'lastClinicalReviewDate',p.last_clinical_review_date,'reviewedBy',p.reviewed_by,'nextReviewDue',p.next_review_due,
      'regulationReviewDate',p.regulation_review_date,'reviewNotes',p.review_notes)
      from public.course_provider_profiles p where p.course_id=c.id),
    'packages',coalesce((select jsonb_agg(jsonb_build_object('id',lp.id,'standard',lp.standard_type,
      'contentSha256',lp.content_sha256,'entryPoint',lp.entry_point,'manifest',lp.manifest,'capabilities',lp.capabilities,
      'connectivityMode',lp.connectivity_mode,'validationStatus',lp.validation_status) order by lp.id)
      from public.learning_packages lp where lp.course_version_id=v.id and lp.organization_id is null),'[]'::jsonb)
  )::text as payload
  from public.courses c join public.course_versions v on v.id=c.current_version_id and v.course_id=c.id
  where c.organization_id is null and v.organization_id is null
)
select case when exists(select 1 from snapshots where payload ~* '([?&](token|access_token|signature|sig|key|policy|jwt|auth|h|hdnts|hdnea|key-pair-id|api_key|apikey|x-amz-[a-z-]+|x-goog-[a-z-]+)=|"(access_?token|refresh_?token|service_?role_?key|authorization|password|client_?secret|storage_?(path|bucket)|video_?url|playback_?(url|token)|signed_?url|api_?key|token|secret|secret_?key|signing_?secret)"[[:space:]]*:)')
then jsonb_build_object('error','Source content contains an excluded credential or storage field. Review it in CareBase before exporting.')
else jsonb_build_object('contract','carebase.catalog-snapshot.v1','scope','global-courses-with-current-version',
  'courses',coalesce(jsonb_agg(jsonb_build_object('sourceRevision',encode(extensions.digest(payload,'sha256'),'hex'),
  'payload',payload) order by id),'[]'::jsonb)) end as governed_catalog from snapshots;
