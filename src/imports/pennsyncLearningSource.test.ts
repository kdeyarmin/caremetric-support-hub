import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
import fixture from './fixtures/pennsyncLearningSource.json';
import {sourceDigest} from './governedLearningImport';
import {validatePennsyncSource,summarizePennsyncSource,pennsyncSourceSchema,pennsyncSummarySchema} from './pennsyncLearningSource';
async function check(value:unknown){const payload=JSON.stringify(value);return validatePennsyncSource(payload,await sourceDigest(payload));}
it('preserves private source content and distinguishes unmatched module history without mapping a user',async()=>{
 const result=await check(fixture),summary=summarizePennsyncSource(result);
 expect(summary).toMatchObject({courses:1,modules:2,standaloneModules:1,questions:1,historyRecords:1,unmatchedLegacyLearners:1,brokenReferences:0});
 expect(summary.catalog).toHaveLength(2);expect(JSON.stringify(summary)).not.toContain('unmatched@example.test');
 expect(result.records.TrainingQuestion[0].fields.correct_answer_json).toEqual({answer:['a','b']});
});
it('both database schemas match the production decoder',()=>{
 const sql=readFileSync('supabase/migrations/20260912002000_pennsync_learning_source.sql','utf8');
 expect(sql).toContain(JSON.stringify(z.toJSONSchema(pennsyncSourceSchema,{target:'draft-7'})));
 expect(sql).toContain(JSON.stringify(z.toJSONSchema(pennsyncSummarySchema,{target:'draft-7'})));
});
it('rejects altered digests, fields, duplicate rows, missing entities and source confusion',async()=>{
 await expect(validatePennsyncSource(JSON.stringify(fixture),'b'.repeat(64))).rejects.toThrow();
 for(const change of [
  (v:typeof fixture)=>{v.sourceAppId='b'.repeat(24);},
  (v:typeof fixture)=>{v.records.TrainingCourse.push(v.records.TrainingCourse[0]);},
  (v:typeof fixture)=>{Object.assign(v.records.TrainingCourse[0].fields,{patient_id:'private'});},
  (v:typeof fixture)=>{delete (v.records as Partial<typeof v.records>).TrainingCompletion;},
 ]){const value=structuredClone(fixture);change(value);await expect(check(value)).rejects.toThrow();}
});
it('reports broken references and ambiguous legacy matches rather than guessing identities',async()=>{
 const value=structuredClone(fixture);value.records.TrainingCompletion[0].fields.training_module_id='9'.repeat(24);
 value.records.User.push({...value.records.User[0],id:'7'.repeat(24),fields:{...value.records.User[0].fields,id:'7'.repeat(24),email:'unmatched@example.test'}},
 {...value.records.User[0],id:'8'.repeat(24),fields:{...value.records.User[0].fields,id:'8'.repeat(24),email:'UNMATCHED@example.test'}});
 expect(summarizePennsyncSource(await check(value))).toMatchObject({brokenReferences:1,unmatchedLegacyLearners:0,ambiguousLegacyLearners:1});
});
it('rejects vendor credentials or dangling external reference claims',async()=>{
 const value=structuredClone(fixture);value.records.TrainingCourse[0].fields.title='https://vendor.test/file?token=private';await expect(check(value)).rejects.toThrow();
 await expect(check({...fixture,references:[{entity:'TrainingCourse',sourceId:'9'.repeat(24),path:'/video_url',sha256:'a'.repeat(64),kind:'source_reference'}]})).rejects.toThrow();
});
