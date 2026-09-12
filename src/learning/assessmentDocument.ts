import { z } from 'zod';

const id=z.uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),sourceId=z.string().regex(/^[a-f0-9]{24}$/);
const text=z.string().max(60000),short=z.string().max(2000),list=z.array(short).max(100);
export const richLessonSchema=z.strictObject({
  intro:text.optional(),
  sections:z.array(z.strictObject({heading:short,body:text.optional(),bullets:list.optional(),example:text.optional(),steps:list.optional(),
    pro_tip:text.optional(),warning:text.optional(),do_dont:z.strictObject({do:list.optional(),dont:list.optional()}).optional(),
    mnemonic:text.optional(),regulation_ref:text.optional()})).max(100).optional(),
  case_scenarios:z.array(z.strictObject({title:short,situation:text,patient_context:text.optional(),challenge:text.optional(),guidance:text.optional(),
    what_could_go_wrong:text.optional(),discussion_questions:list.optional()})).max(100).optional(),
  check_your_understanding:list.optional(),clinical_pearl:text.optional(),key_takeaways:list.optional(),summary:text.optional(),
});
export type RichLesson=z.infer<typeof richLessonSchema>;
const source=z.strictObject({id:sourceId,revision:hash});
const option=z.strictObject({id,text:z.string().min(1).max(2000)});
const questionBase={id,source,prompt:z.string().min(1).max(12000),points:z.number().positive().max(100),rationale:text};
const choice={...questionBase,options:z.array(option).min(2).max(50),correctOptionIds:z.array(id).min(1).max(50)};
export const assessmentQuestionSchema=z.discriminatedUnion('kind',[
  z.strictObject({...choice,kind:z.enum(['single_choice','multiple_choice','true_false'])}),
  z.strictObject({...questionBase,kind:z.literal('matching'),options:z.array(option).min(2).max(50),
    pairs:z.array(z.strictObject({id,left:z.string().min(1).max(2000),correctOptionId:id})).min(1).max(50)}),
  z.strictObject({...questionBase,kind:z.enum(['short_answer','scenario_response']),rubric:z.string().min(1).max(60000),provider:z.literal('pennsync.base44-core.v1')}),
]).superRefine((q,ctx)=>{
  if('options' in q){
    const ids=q.options.map(o=>o.id);
    if(new Set(ids).size!==ids.length)ctx.addIssue({code:'custom',message:'Duplicate question option.'});
    const keys='pairs' in q?q.pairs.map(p=>p.correctOptionId):q.correctOptionIds;
    if(keys.some(k=>!ids.includes(k)))ctx.addIssue({code:'custom',message:'Question key does not reference an option.'});
    if('correctOptionIds' in q&&(new Set(keys).size!==keys.length||q.kind!=='multiple_choice'&&keys.length!==1))ctx.addIssue({code:'custom',message:'Invalid answer key cardinality.'});
    if('pairs' in q&&(new Set(q.pairs.map(p=>p.id)).size!==q.pairs.length||new Set(q.pairs.map(p=>p.left)).size!==q.pairs.length))ctx.addIssue({code:'custom',message:'Duplicate matching prompt.'});
  }
});
export type AssessmentQuestion=z.infer<typeof assessmentQuestionSchema>;
export const assessmentPolicySchema=z.strictObject({
  passingScore:z.number().int().min(1).max(100),maxAttempts:z.number().int().min(1).max(100).nullable(),waitingPeriodHours:z.number().min(0).max(8760),
  randomizeQuestions:z.boolean(),randomizeOptions:z.boolean(),reshuffleOnRetake:z.boolean(),showAnswersAfterCompletion:z.boolean(),
  attestation:z.strictObject({required:z.boolean(),statement:text,statementSha256:hash}),
  certificate:z.strictObject({enabled:z.boolean(),validMonths:z.number().int().min(1).max(120).nullable(),wording:text}),
  renewal:z.strictObject({rule:z.enum(['none','annual','quarterly','on_hire']),cycleYear:z.number().int().min(2000).max(2200).nullable()}),
});
export const assessmentDocumentSchema=z.strictObject({
  contract:z.literal('caremetric.learning-document.v2'),source:z.strictObject({app:z.literal('pennsync'),snapshotRevision:hash,course:source}),
  title:z.string().min(2).max(500),summary:text,overview:text,purpose:text,realWorldRelevance:text,readingLevel:short,category:z.string().max(100),durationMinutes:z.number().positive().max(1440),
  learningObjectives:list,tags:list,
  audience:z.strictObject({product:z.literal('pennsync'),access:z.literal('unpublished'),businessLine:z.enum(['all','home_health','hospice']),description:short,roles:list,mandatory:z.boolean()}),
  clinicalReviewRequired:z.boolean(),
  regulatoryCrosswalk:z.array(z.strictObject({regulation:short,title:short.optional(),how_this_course_addresses_it:text})).max(100),
  competencySkills:z.array(z.strictObject({skill:short,criteria:text,validation_method:short.optional()})).max(100),
  lessons:z.array(z.strictObject({id,source,title:z.string().min(1).max(500),durationMinutes:z.number().nonnegative().max(1440),content:richLessonSchema})).min(1).max(150),
  assessment:z.strictObject({id,policy:assessmentPolicySchema,questions:z.array(assessmentQuestionSchema).max(100)}),
}).superRefine((d,ctx)=>{
  const ids=[...d.lessons.map(l=>l.id),d.assessment.id,...d.assessment.questions.map(q=>q.id)];
  if(new Set(ids).size!==ids.length)ctx.addIssue({code:'custom',message:'Duplicate learning identity.'});
  if(!d.assessment.questions.length&&!d.assessment.policy.attestation.required)ctx.addIssue({code:'custom',message:'A course requires an assessment or attestation.'});
});
export type AssessmentDocument=z.infer<typeof assessmentDocumentSchema>;

// Construct the learner projection from an allowlist. New private fields cannot
// become public just because they were added to an import or provider response.
export function publicAssessmentQuestion(q:AssessmentQuestion){
  const base={id:q.id,kind:q.kind,prompt:q.prompt,points:q.points};
  if(q.kind==='matching')return {...base,options:q.options.map(o=>({id:o.id,text:o.text})),pairs:q.pairs.map(p=>({id:p.id,left:p.left}))};
  if('options' in q)return {...base,options:q.options.map(o=>({id:o.id,text:o.text}))};
  return base;
}
