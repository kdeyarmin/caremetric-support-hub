import { z } from 'zod';
import { assessmentDocumentSchema,assessmentQuestionSchema,richLessonSchema } from '../learning/assessmentDocument.ts';
import type { AssessmentDocument,AssessmentQuestion } from '../learning/assessmentDocument.ts';
import type { PennsyncSource } from './pennsyncLearningSource.ts';
import { sourceDigest } from './governedLearningImport.ts';

type Row=PennsyncSource['records'][string][number];
type Fields=Row['fields'];
export const conversionIssueSchema=z.strictObject({code:z.enum(['missing_lessons','empty_lesson','invalid_source','inactive_questions','untransferred_material','clinical_review','unpublished_source','supplementary_assessment','credit_policy']),message:z.string().max(250)});
export type ConversionIssue=z.infer<typeof conversionIssueSchema>;
export type PennsyncCourseConversion={sourceId:string;title:string;sourceStatus:string;document:AssessmentDocument|null;issues:ConversionIssue[]};
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const value=z.union([z.string(),z.boolean(),z.number().finite()]);
const optionsSchema=z.array(z.object({value,label:z.string().min(1)})).min(2).max(50);
const jsonObject=(v:unknown)=>z.record(z.string(),z.unknown()).parse(v);
const finite=(v:unknown,fallback?:number)=>z.number().finite().parse(v??fallback);
const string=(v:unknown,fallback='')=>z.string().parse(v??fallback);
const strings=(v:unknown)=>z.array(z.string()).parse(v??[]);
const boolean=(v:unknown,fallback?:boolean)=>z.boolean().parse(v??fallback);
const nonempty=(v:unknown)=>v!==null&&v!==undefined&&v!==''&&JSON.stringify(v)!=='[]'&&JSON.stringify(v)!=='{}';

export async function learningSourceId(namespace:string,key:string){
  const h=await sourceDigest(`caremetric.pennsync.learning.v2:${namespace}:${key}`);
  // UUID v8: deterministic identity within this application-defined namespace.
  return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-${((parseInt(h[16],16)&3)|8).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;
}
function normalizeOption(v:unknown,multiple:boolean){
  return multiple?String(value.parse(v)).toLowerCase().replace(/\s+/g,''):JSON.stringify(value.parse(v)).toLowerCase().replace(/\s+/g,'');
}
async function convertQuestion(row:Row):Promise<AssessmentQuestion>{
  const f=row.fields,type=string(f.type),id=await learningSourceId('question',row.id);
  const base={id,source:{id:row.id,revision:row.revision},prompt:string(f.prompt),points:finite(f.points,1),rationale:string(f.rationale)};
  if(type==='short_answer'||type==='scenario_based')return assessmentQuestionSchema.parse({...base,kind:type==='short_answer'?'short_answer':'scenario_response',
    rubric:string(f.rubric)||string(f.rationale),provider:'pennsync.base44-core.v1'});
  const kindMap={mcq:'single_choice',multi_select:'multiple_choice',true_false:'true_false',matching:'matching'} as const;
  const kind=kindMap[type as keyof typeof kindMap];
  if(!kind)throw new Error('Unsupported question type');
  const sourceOptions=optionsSchema.parse(f.options_json),optionIds=new Map<string,string>();
  const options=await Promise.all(sourceOptions.map(async option=>{
    const normalized=normalizeOption(option.value,kind==='multiple_choice');
    if(optionIds.has(normalized))throw new Error('Ambiguous normalized options');
    // Reserve before awaiting so duplicate options cannot race through the map.
    optionIds.set(normalized,'');
    const optionId=await learningSourceId('option',`${row.id}:${normalized}`);optionIds.set(normalized,optionId);
    return {id:optionId,text:option.label};
  }));
  const lookup=(v:unknown)=>{const found=optionIds.get(normalizeOption(v,kind==='multiple_choice'));if(!found)throw new Error('Answer has no source option');return found;};
  const correct=jsonObject(f.correct_answer_json).answer;
  if(kind==='matching'){
    const pairs=z.array(z.object({left:z.string().min(1),right:value})).min(1).parse(jsonObject(correct).pairs);
    return assessmentQuestionSchema.parse({...base,kind,options,pairs:await Promise.all(pairs.map(async p=>({id:await learningSourceId('pair',`${row.id}:${p.left}`),left:p.left,correctOptionId:lookup(p.right)})))});
  }
  return assessmentQuestionSchema.parse({...base,kind,options,correctOptionIds:kind==='multiple_choice'?z.array(value).min(1).parse(correct).map(lookup):[lookup(correct)]});
}
function order(rows:Row[]){
  return [...rows].sort((a,b)=>finite(a.fields.order_index??a.fields.order,0)-finite(b.fields.order_index??b.fields.order,0)||a.id.localeCompare(b.id));
}
function textPresent(v:unknown):boolean{
  if(typeof v==='string')return Boolean(v.trim());
  if(Array.isArray(v))return v.some(textPresent);
  return Boolean(v&&typeof v==='object'&&Object.values(v).some(textPresent));
}
async function policy(f:Fields){
  const retake=jsonObject(f.retake_settings_json),test=jsonObject(f.test_settings_json);
  // Match the native grader: a finite course cap wins even if a legacy
  // unlimited_retakes flag contradicts it. Record the original in the snapshot.
  const cap=retake.max_attempts==null?null:finite(retake.max_attempts);
  const statement=string(f.attestation_text)||'I have reviewed and understand this training.';
  return {passingScore:finite(f.passing_score??retake.passing_threshold,80),maxAttempts:cap!==null&&cap>0?cap:null,
    waitingPeriodHours:finite(retake.waiting_period_hours,0),randomizeQuestions:boolean(test.randomize_questions,false),randomizeOptions:boolean(test.randomize_answers,false),
    reshuffleOnRetake:boolean(retake.regenerate_test_on_retake,false),showAnswersAfterCompletion:boolean(test.show_correct_answers_after_completion,f.allow_answer_review===true),
    attestation:{required:boolean(f.requires_attestation,false),statement,statementSha256:await sourceDigest(statement)},
    certificate:{enabled:boolean(f.enable_certificate,true),validMonths:f.certificate_valid_months==null?null:finite(f.certificate_valid_months),wording:string(f.certificate_wording)},
    renewal:{rule:string(f.recurrence_rule,'none'),cycleYear:f.annual_cycle_year==null?null:finite(f.annual_cycle_year)}};
}
export async function convertPennsyncCourses(source:PennsyncSource,sourceRevision:string):Promise<PennsyncCourseConversion[]>{
  hash.parse(sourceRevision);
  const converted:PennsyncCourseConversion[]=[];
  for(const course of source.records.TrainingCourse){
    const f=course.fields,issues:ConversionIssue[]=[],result:PennsyncCourseConversion={sourceId:course.id,title:typeof f.title==='string'?f.title:'Untitled source',sourceStatus:typeof f.status==='string'?f.status:'unspecified',document:null,issues};
    const issue=(code:ConversionIssue['code'],message:string)=>issues.push({code,message});
    if(f.status!=='published'||f.archived_status===true)issue('unpublished_source','This source course is not currently published.');
    if(f.needs_sme_review===true)issue('clinical_review','The original course still requires a clinical reviewer.');
    if(nonempty(f.ceu_hours)&&Number(f.ceu_hours)!==0)issue('credit_policy','Continuing education credit requires a verified central credit policy.');
    if(nonempty(f.pre_assessment_json)||nonempty(f.brain_sparks_json))issue('supplementary_assessment','Preserved pre-assessments or follow-up questions require a matching delivery policy.');
    if(nonempty(f.policy_references))issue('untransferred_material','Referenced policy documents require a verified central policy mapping.');
    try{
      const modules=order(source.records.TrainingModule.filter(m=>m.fields.course_id===course.id));
      const allQuestions=order(source.records.TrainingQuestion.filter(q=>q.fields.course_id===course.id));
      const questions=allQuestions.filter(q=>q.fields.active===true);
      if(!modules.length)issue('missing_lessons','No source lessons exist for this course.');
      if(allQuestions.length&&!questions.length)issue('inactive_questions','The source question bank has no active questions.');
      const relevantIds=new Set([course.id,...modules.map(m=>m.id),...questions.map(q=>q.id)]);
      if(source.references.some(ref=>relevantIds.has(ref.sourceId)&&ref.path!=='/ai_prompt_json'))issue('untransferred_material','Referenced source material requires transfer and verification.');
      const lessons=[];
      for(const module of modules){
        const mf=module.fields;
        if(mf.is_active===false||mf.video_url||mf.content_url||nonempty(mf.attachment_urls)||mf.content_type&&mf.content_type!=='text')issue('untransferred_material','A source lesson requires an active, verified central material asset.');
        const content=richLessonSchema.parse(mf.content_json??(typeof mf.content==='string'?{intro:mf.content}:{}));
        if(!textPresent(content))issue('empty_lesson','A source lesson has no readable content.');
        lessons.push({id:await learningSourceId('lesson',module.id),source:{id:module.id,revision:module.revision},title:string(mf.title),durationMinutes:finite(mf.estimated_minutes??mf.duration_minutes,0),content});
      }
      const document={contract:'caremetric.learning-document.v2',source:{app:'pennsync',snapshotRevision:sourceRevision,course:{id:course.id,revision:course.revision}},
        title:string(f.title),summary:string(f.short_description),overview:string(f.description),purpose:string(f.purpose),realWorldRelevance:string(f.real_world_relevance),readingLevel:string(f.reading_level),category:string(f.category),durationMinutes:finite(f.estimated_minutes),
        learningObjectives:strings(f.learning_objectives),tags:strings(f.tags),
        audience:{product:'pennsync',access:'unpublished',businessLine:string(f.business_line_scope,'all'),description:string(f.employee_audience),roles:strings(f.role_targets),mandatory:boolean(f.is_mandatory,false)},
        clinicalReviewRequired:boolean(f.needs_sme_review,false),regulatoryCrosswalk:f.regulatory_crosswalk_json??[],competencySkills:f.competency_skills_json??[],lessons,
        assessment:{id:await learningSourceId('assessment',course.id),policy:await policy(f),questions:await Promise.all(questions.map(convertQuestion))}};
      if(modules.length)result.document=assessmentDocumentSchema.parse(document);
    }catch{issue('invalid_source','A source content or assessment structure needs review before it can be delivered faithfully.');}
    converted.push(result);
  }
  return converted;
}
