import { z } from 'zod';
import sourceFields from './pennsyncSourceFields.json' with { type: 'json' };
import { sourceDigest } from './governedLearningImport.ts';

const hash=z.string().regex(/^[a-f0-9]{64}$/), id=z.string().regex(/^[a-f0-9]{24}$/);
const sourceRecord=z.strictObject({id,revision:hash,fields:z.record(z.string().max(160),z.json())});
export const pennsyncEntities=Object.keys(sourceFields) as Array<keyof typeof sourceFields>;
export const pennsyncSourceSchema=z.strictObject({contract:z.literal('pennsync.learning-source.v1'),sourceAppId:z.literal('694ec16e72e01b60d22f7cbf'),
  scope:z.literal('private-administrator-migration'),records:z.strictObject(Object.fromEntries(pennsyncEntities.map(name=>[name,z.array(sourceRecord).max(10000)]))),
  references:z.array(z.strictObject({entity:z.enum(pennsyncEntities as [string,...string[]]),sourceId:id,path:z.string().max(2000),sha256:hash,kind:z.enum(['source_reference','embedded_reference'])})).max(10000)});
export type PennsyncSource=z.infer<typeof pennsyncSourceSchema>;
export const pennsyncNativeOperation=z.strictObject({operation:z.literal('learning.source.snapshot')});
export const pennsyncMigrationOperation=z.discriminatedUnion('operation',[
  z.strictObject({operation:z.literal('inspect')}),
  z.strictObject({operation:z.literal('preserve'),sourceRevision:hash,expectedHeadRevision:hash.nullable(),reviewed:z.literal(true)}),
]);
export const pennsyncSummarySchema=z.strictObject({courses:z.number().int().nonnegative(),modules:z.number().int().nonnegative(),standaloneModules:z.number().int().nonnegative(),
  questions:z.number().int().nonnegative(),plans:z.number().int().nonnegative(),planCourses:z.number().int().nonnegative(),historyRecords:z.number().int().nonnegative(),
  unmatchedLegacyLearners:z.number().int().nonnegative(),ambiguousLegacyLearners:z.number().int().nonnegative(),sourceReferences:z.number().int().nonnegative(),
  brokenReferences:z.number().int().nonnegative(),catalog:z.array(z.strictObject({id,kind:z.enum(['course','standalone_module']),title:z.string().max(500),
    status:z.string().max(80),modules:z.number().int().nonnegative(),questions:z.number().int().nonnegative(),issues:z.array(z.string().max(150)).max(25)})).max(20000)});
export type PennsyncSummary=z.infer<typeof pennsyncSummarySchema>;
export const pennsyncMigrationResult=z.strictObject({sourceRevision:hash,headRevision:hash.nullable(),snapshotId:z.uuid().nullable(),replayed:z.boolean(),summary:pennsyncSummarySchema});

function records(source:PennsyncSource,name:keyof typeof sourceFields){return source.records[name] as Array<z.infer<typeof sourceRecord>>;}
export async function validatePennsyncSource(payload:string,revision:string):Promise<PennsyncSource> {
  if(new TextEncoder().encode(payload).length>7000000||await sourceDigest(payload)!==revision)throw new Error('PennSync source checksum does not match.');
  const source=pennsyncSourceSchema.parse(JSON.parse(payload));
  for(const name of pennsyncEntities) {
    let previous='';
    for(const row of records(source,name)) {
      if(row.id<=previous||row.fields.id!==row.id||Object.keys(row.fields).some(key=>!(sourceFields[name] as string[]).includes(key)))throw new Error('Invalid PennSync source ordering or fields.');
      previous=row.id;
    }
  }
  // This source never carries vendor download credentials into the Hub.
  if(/https?:\/\/|Bearer\s+|[?&](?:token|signature|x-amz-[a-z-]+)=/i.test(payload))throw new Error('PennSync source contains an unstaged external reference.');
  for(const ref of source.references) {
    const row=source.records[ref.entity]?.find(value=>value.id===ref.sourceId);
    if(!row)throw new Error('PennSync source reference has no record.');
    let target:unknown=row.fields;
    for(const rawKey of ref.path.split('/').slice(1)){const key=rawKey.replace(/~1/g,'/').replace(/~0/g,'~');if(!target||typeof target!=='object')throw new Error('Invalid source reference path.');target=(target as Record<string,unknown>)[key];}
    if(!target||typeof target!=='object'||(target as Record<string,unknown>).sourceReferenceSha256!==ref.sha256)throw new Error('Invalid source reference checksum.');
  }
  return source;
}
export function summarizePennsyncSource(source:PennsyncSource):PennsyncSummary {
  const courses=records(source,'TrainingCourse'),modules=records(source,'TrainingModule'),questions=records(source,'TrainingQuestion');
  const courseIds=new Set(courses.map(row=>row.id)),moduleIds=new Set(modules.map(row=>row.id)),plans=records(source,'LearningPlan'),planIds=new Set(plans.map(row=>row.id));
  let brokenReferences=0;
  for(const name of ['TrainingModule','TrainingQuestion','TrainingAssignment','TrainingCertificate','TrainingAttempt','TrainingAttestation','LearningPlanCourse'] as const)
    for(const row of records(source,name))if(row.fields.course_id&&!courseIds.has(String(row.fields.course_id)))brokenReferences++;
  for(const name of ['TrainingAssignment','LearningPlanCourse'] as const)
    for(const row of records(source,name))if(row.fields.plan_id&&!planIds.has(String(row.fields.plan_id)))brokenReferences++;
  for(const row of records(source,'TrainingCompletion'))if(!moduleIds.has(String(row.fields.training_module_id)))brokenReferences++;
  const emails=new Map<string,number>();
  for(const row of records(source,'User'))if(typeof row.fields.email==='string'){const email=row.fields.email.trim().toLowerCase();emails.set(email,(emails.get(email)??0)+1);}
  const legacyEmails=new Set(records(source,'TrainingCompletion').map(row=>typeof row.fields.nurse_email==='string'?row.fields.nurse_email.trim().toLowerCase():'').filter(Boolean));
  const standalone=modules.filter(row=>!row.fields.course_id);
  const catalog:PennsyncSummary['catalog']=[];
  for(const [kind,rows] of [['course',courses],['standalone_module',standalone]] as const)for(const row of rows){
    const related=kind==='course'?modules.filter(module=>module.fields.course_id===row.id):[row];
    const assessment=kind==='course'?questions.filter(question=>question.fields.course_id===row.id):[];
    const issues=['Agency and audience mapping required'];
    if(!related.length)issues.push('No source lessons');
    if(assessment.some(q=>!['mcq','true_false'].includes(String(q.fields.type))))issues.push('Advanced assessment behavior must be preserved');
    if(source.references.some(ref=>ref.sourceId===row.id||related.some(module=>module.id===ref.sourceId)))issues.push('External material requires transfer and verification');
    if(row.fields.ceu_hours||row.fields.enable_certificate!==false||row.fields.recurrence_rule&&row.fields.recurrence_rule!=='none')issues.push('Credit, certificate and renewal policy requires reconciliation');
    if(kind==='standalone_module'&&records(source,'TrainingCompletion').some(history=>history.fields.training_module_id===row.id))issues.push('Legacy learner history requires identity reconciliation');
    catalog.push({id:row.id,kind,title:typeof row.fields.title==='string'?row.fields.title.slice(0,500):'Untitled source',status:typeof row.fields.status==='string'?row.fields.status.slice(0,80):row.fields.is_active===false?'inactive':'unspecified',modules:related.length,questions:assessment.length,issues});
  }
  return pennsyncSummarySchema.parse({courses:courses.length,modules:modules.length,standaloneModules:standalone.length,questions:questions.length,plans:plans.length,
    planCourses:records(source,'LearningPlanCourse').length,historyRecords:['TrainingCompletion','TrainingAssignment','TrainingAttempt','TrainingAttestation','TrainingCertificate'].reduce((sum,name)=>sum+source.records[name].length,0),
    unmatchedLegacyLearners:[...legacyEmails].filter(email=>!emails.has(email)).length,ambiguousLegacyLearners:[...legacyEmails].filter(email=>(emails.get(email)??0)>1).length,
    sourceReferences:source.references.length,brokenReferences,catalog});
}
