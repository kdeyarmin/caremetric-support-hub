import {z} from 'zod';
import {assessmentDocumentSchema,assessmentPolicySchema,publicAssessmentQuestion,richLessonSchema} from '../learning/assessmentDocument.ts';
import {conversionIssueSchema} from './pennsyncCourseImport.ts';
import type {PennsyncCourseConversion} from './pennsyncCourseImport.ts';

const id=z.uuid(),text=z.string().max(60000),list=z.array(z.string().max(2000)).max(100);
const option=z.strictObject({id,text:z.string().min(1).max(2000)});
const q={id,prompt:z.string().min(1).max(12000),points:z.number().positive().max(100)};
export const learnerAssessmentQuestionSchema=z.discriminatedUnion('kind',[
  z.strictObject({...q,kind:z.enum(['single_choice','multiple_choice','true_false']),options:z.array(option).min(2).max(50)}),
  z.strictObject({...q,kind:z.literal('matching'),options:z.array(option).min(2).max(50),pairs:z.array(z.strictObject({id,left:z.string().min(1).max(2000)})).min(1).max(50)}),
  z.strictObject({...q,kind:z.enum(['short_answer','scenario_response'])}),
]);
export const pennsyncCourseReviewSchema=z.strictObject({
  sourceRevision:z.string().regex(/^[a-f0-9]{64}$/),courses:z.array(z.strictObject({
    sourceId:z.string().regex(/^[a-f0-9]{24}$/),title:z.string().max(500),sourceStatus:z.string().max(80),issues:z.array(conversionIssueSchema).max(500),
    preview:z.strictObject({overview:text,purpose:text,summary:text,realWorldRelevance:text,readingLevel:z.string().max(2000),learningObjectives:list,
      regulatoryCrosswalk:assessmentDocumentSchema.shape.regulatoryCrosswalk,competencySkills:assessmentDocumentSchema.shape.competencySkills,
      audience:z.strictObject({description:z.string().max(2000),businessLine:z.enum(['all','home_health','hospice']),roles:list,mandatory:z.boolean()}),
      policy:assessmentPolicySchema,lessons:z.array(z.strictObject({id,title:z.string().max(500),content:richLessonSchema})).max(150),
      questions:z.array(learnerAssessmentQuestionSchema).max(100)}).nullable(),
  })).max(500),standaloneModules:z.number().int().nonnegative(),unmatchedLearners:z.number().int().nonnegative(),
});
export type PennsyncCourseReview=z.infer<typeof pennsyncCourseReviewSchema>;
export function reviewPennsyncCourses(courses:PennsyncCourseConversion[],sourceRevision:string,standaloneModules:number,unmatchedLearners:number):PennsyncCourseReview{
  return pennsyncCourseReviewSchema.parse({sourceRevision,standaloneModules,unmatchedLearners,courses:courses.map(row=>{
    const d=row.document;
    return {sourceId:row.sourceId,title:row.title,sourceStatus:row.sourceStatus,issues:row.issues,
      preview:d?{overview:d.overview,purpose:d.purpose,summary:d.summary,realWorldRelevance:d.realWorldRelevance,readingLevel:d.readingLevel,learningObjectives:d.learningObjectives,
        regulatoryCrosswalk:d.regulatoryCrosswalk,competencySkills:d.competencySkills,
        audience:{description:d.audience.description,businessLine:d.audience.businessLine,roles:d.audience.roles,mandatory:d.audience.mandatory},
        policy:d.assessment.policy,lessons:d.lessons.map(l=>({id:l.id,title:l.title,content:l.content})),questions:d.assessment.questions.map(publicAssessmentQuestion)}:null};
  })});
}
