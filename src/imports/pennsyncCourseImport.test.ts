import {expect,it} from 'vitest';
import fixture from './fixtures/pennsyncLearningSource.json';
import {pennsyncSourceSchema} from './pennsyncLearningSource';
import {convertPennsyncCourses} from './pennsyncCourseImport';
import {reviewPennsyncCourses} from './pennsyncCourseReview';
import {assessmentDocumentSchema} from '../learning/assessmentDocument';
const revision='a'.repeat(64);
function source(){
  const s=pennsyncSourceSchema.parse(structuredClone(fixture)),f=s.records.TrainingCourse[0].fields,q=s.records.TrainingQuestion[0].fields;
  Object.assign(f,{ceu_hours:null,estimated_minutes:30,requires_attestation:true,attestation_text:'I have reviewed the complete training.',certificate_valid_months:12,
    enable_certificate:true,certificate_wording:'Completed the annual course.',recurrence_rule:'annual',annual_cycle_year:2026,needs_sme_review:false,
    role_targets:['RN','LPN'],employee_audience:'Licensed nursing staff',business_line_scope:'all',is_mandatory:true,
    retake_settings_json:{max_attempts:3,passing_threshold:80,waiting_period_hours:24,unlimited_retakes:false,regenerate_test_on_retake:true},
    test_settings_json:{randomize_questions:true,randomize_answers:true,show_correct_answers_after_completion:false}});
  Object.assign(q,{active:true,points:1,options_json:[{value:'a',label:'First'},{value:'b',label:'Second'},{value:'c',label:'Third'}]});
  return s;
}
it('preserves structured material, exact policy, source provenance and immutable input',async()=>{
  const s=source(),original=JSON.stringify(s);
  const [result]=await convertPennsyncCourses(s,revision),d=result.document!;
  expect(result.issues).toEqual([]);expect(d.lessons[0].content).toEqual({intro:'Exact lesson content'});
  expect(d.source).toEqual({app:'pennsync',snapshotRevision:revision,course:{id:s.records.TrainingCourse[0].id,revision}});
  expect(d.assessment.policy).toMatchObject({passingScore:80,maxAttempts:3,waitingPeriodHours:24,reshuffleOnRetake:true,
    randomizeQuestions:true,randomizeOptions:true,showAnswersAfterCompletion:false,attestation:{required:true,statement:'I have reviewed the complete training.'},certificate:{enabled:true,validMonths:12},renewal:{rule:'annual',cycleYear:2026}});
  expect(d.audience).toMatchObject({product:'pennsync',access:'unpublished',roles:['RN','LPN']});
  expect(JSON.stringify(s)).toBe(original);expect(assessmentDocumentSchema.parse(d)).toEqual(d);
});
it('normalizes multi-select keys like the native grader and keeps option identities stable across ordering',async()=>{
  const s=source(),q=s.records.TrainingQuestion[0].fields;q.correct_answer_json={answer:[' B ','A']};
  const first=(await convertPennsyncCourses(s,revision))[0].document!.assessment.questions[0];
  q.options_json=[{value:'c',label:'Third'},{value:'b',label:'Second'},{value:'a',label:'First'}];
  const second=(await convertPennsyncCourses(s,revision))[0].document!.assessment.questions[0];
  expect(first.kind).toBe('multiple_choice');expect('correctOptionIds' in first&&first.correctOptionIds).toEqual('correctOptionIds' in second&&second.correctOptionIds);
  expect('options' in first&&first.options.map(o=>o.id).sort()).toEqual('options' in second&&second.options.map(o=>o.id).sort());
});
it.each(['short_answer','scenario_based'])('preserves %s as provider-graded freeform rather than an objective answer',async type=>{
  const s=source();Object.assign(s.records.TrainingQuestion[0].fields,{type,rubric:'Private grading rubric',rationale:'Private rationale'});
  const d=(await convertPennsyncCourses(s,revision))[0].document!;
  expect(d.assessment.questions[0]).toMatchObject({provider:'pennsync.base44-core.v1',rubric:'Private grading rubric'});
  const review=reviewPennsyncCourses(await convertPennsyncCourses(s,revision),revision,1,1),json=JSON.stringify(review);
  expect(json).not.toContain('Private grading rubric');expect(json).not.toContain('Private rationale');expect(json).not.toContain('unmatched@example.test');
  expect(json).not.toContain('sourceReferenceSha256');expect(json).not.toContain('provider');
});
it('projects matching left prompts without revealing the correct pairs',async()=>{
  const s=source();Object.assign(s.records.TrainingQuestion[0].fields,{type:'matching',correct_answer_json:{answer:{pairs:[{left:'First prompt',right:'a'},{left:'Second prompt',right:'b'}]}}});
  const converted=await convertPennsyncCourses(s,revision),d=converted[0].document!;
  expect(d.assessment.questions[0].kind).toBe('matching');
  const review=reviewPennsyncCourses(converted,revision,1,1);expect(JSON.stringify(review)).not.toContain('correctOption');
  expect(review.courses[0].preview!.questions[0]).toMatchObject({pairs:[{left:'First prompt'},{left:'Second prompt'}]});
});
it.each([
  ['ambiguous options',(s:ReturnType<typeof source>)=>{s.records.TrainingQuestion[0].fields.options_json=[{value:'A',label:'First'},{value:' a ',label:'Second'}];}],
  ['unknown question kind',(s:ReturnType<typeof source>)=>{s.records.TrainingQuestion[0].fields.type='code_execution';}],
  ['unknown lesson structure',(s:ReturnType<typeof source>)=>{s.records.TrainingModule[0].fields.content_json={intro:'Lesson',unknown_required_section:'Must not disappear'};}],
  ['missing answer',(s:ReturnType<typeof source>)=>{s.records.TrainingQuestion[0].fields.correct_answer_json={answer:['missing']};}],
  ['missing freeform rubric',(s:ReturnType<typeof source>)=>{Object.assign(s.records.TrainingQuestion[0].fields,{type:'short_answer',rubric:'',rationale:''});}],
] as const)('blocks %s without altering source records',async(_label,change)=>{
  const s=source();change(s);const original=JSON.stringify(s),[row]=await convertPennsyncCourses(s,revision);
  expect(row.document).toBeNull();expect(row.issues.some(i=>i.code==='invalid_source')).toBe(true);expect(JSON.stringify(s)).toBe(original);
});
it('keeps missing material, inactive assessment, clinical review and supplementary policy blockers',async()=>{
  const s=source();Object.assign(s.records.TrainingCourse[0].fields,{needs_sme_review:true,pre_assessment_json:[{prompt:'Preserved'}]});
  s.records.TrainingQuestion[0].fields.active=false;s.records.TrainingModule[0].fields.content_json={};
  const [row]=await convertPennsyncCourses(s,revision);expect(row.issues.map(i=>i.code)).toEqual(expect.arrayContaining(['clinical_review','supplementary_assessment','inactive_questions','empty_lesson']));
  s.records.TrainingModule=[];expect((await convertPennsyncCourses(s,revision))[0]).toMatchObject({document:null,issues:expect.arrayContaining([{code:'missing_lessons',message:'No source lessons exist for this course.'}])});
});
it('distinguishes required material references from a private authoring prompt',async()=>{
  const s=source(),course=s.records.TrainingCourse[0];
  s.references=[{entity:'TrainingCourse',sourceId:course.id,path:'/ai_prompt_json',sha256:revision,kind:'source_reference'}];
  expect((await convertPennsyncCourses(s,revision))[0].issues).toEqual([]);
  s.references.push({...s.references[0],path:'/attachment_urls/0'});
  expect((await convertPennsyncCourses(s,revision))[0].issues.some(i=>i.code==='untransferred_material')).toBe(true);
});
it('retains the native finite course cap even when an inconsistent legacy unlimited flag is true',async()=>{
  const s=source();(s.records.TrainingCourse[0].fields.retake_settings_json as Record<string,unknown>).unlimited_retakes=true;
  expect((await convertPennsyncCourses(s,revision))[0].document!.assessment.policy.maxAttempts).toBe(3);
});
