import {useState} from 'react';
import {pennsyncCourseReviewSchema} from '../imports/pennsyncCourseReview';
import type {PennsyncCourseReview} from '../imports/pennsyncCourseReview';
import {RichLessonContent} from './RichLessonContent';

export function PennsyncCourseReviewPanel({sourceRevision}:{sourceRevision:string}){
  const [review,setReview]=useState<PennsyncCourseReview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function load(){
    setBusy(true);setError('');setReview(null);
    try{
      const response=await fetch('/api/admin/pennsync-migration',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'review',sourceRevision})});
      if(!response.ok)throw new Error(response.status===409?'The preserved source changed. Inspect and preserve the current source before reviewing it.':'Course review is unavailable. Check your administrator session and try again.');
      const result=pennsyncCourseReviewSchema.parse(await response.json());
      if(result.sourceRevision!==sourceRevision)throw new Error('The course review does not match the selected source.');
      setReview(result);
    }catch(caught){setError(caught instanceof Error?caught.message:'Course review did not complete.');}
    finally{setBusy(false);}
  }
  return <section aria-label="Preserved course review"><h3>Review preserved course content</h3>
    <p>Check the lessons, question formats, audience, and completion rules before these courses move into Hub delivery.</p>
    <button className="button button-secondary" disabled={busy} onClick={()=>void load()}>{busy?'Loading course review…':'Review preserved courses'}</button>
    {error&&<p role="alert" className="learning-error">{error}</p>}
    {review&&<><p role="status">{review.courses.filter(c=>c.preview).length} courses converted for review. Publication and learner access have not changed.</p>
      {review.standaloneModules>0&&<p>{review.standaloneModules} standalone modules remain in the source record for separate content and history reconciliation.</p>}
      {review.unmatchedLearners>0&&<p>{review.unmatchedLearners} unmatched legacy learners remain unlinked.</p>}
      {review.courses.map(course=><details key={course.sourceId}><summary>{course.title}</summary>
        <p>Source status: {course.sourceStatus}</p>{course.issues.length>0&&<ul>{course.issues.map((issue,i)=><li key={`${issue.code}:${i}`}>{issue.message}</li>)}</ul>}
        {course.preview&&<>
          <p>{course.preview.summary}</p><p>{course.preview.overview}</p>{course.preview.purpose&&<p>{course.preview.purpose}</p>}
          {course.preview.realWorldRelevance&&<p><strong>Why this matters: </strong>{course.preview.realWorldRelevance}</p>}
          {course.preview.readingLevel&&<p>Reading level: {course.preview.readingLevel}</p>}
          {course.preview.learningObjectives.length>0&&<><h4>Learning objectives</h4><ul>{course.preview.learningObjectives.map((v,i)=><li key={i}>{v}</li>)}</ul></>}
          {course.preview.regulatoryCrosswalk.length>0&&<><h4>Regulatory references</h4>{course.preview.regulatoryCrosswalk.map((entry,i)=><div key={i}><p><strong>{entry.regulation}{entry.title?` · ${entry.title}`:''}</strong></p><p>{entry.how_this_course_addresses_it}</p></div>)}</>}
          {course.preview.competencySkills.length>0&&<><h4>Competency skills</h4>{course.preview.competencySkills.map((entry,i)=><div key={i}><p><strong>{entry.skill}</strong></p><p>{entry.criteria}</p>{entry.validation_method&&<p>{entry.validation_method}</p>}</div>)}</>}
          <h4>Audience</h4><p>{course.preview.audience.description} · {course.preview.audience.businessLine.replace('_',' ')}</p>
          <p>{course.preview.audience.roles.join(', ')}</p>
          <h4>Assessment and completion rules</h4>
          <p>Passing score: {course.preview.policy.passingScore}%. {course.preview.policy.maxAttempts===null?'Unlimited attempts':`${course.preview.policy.maxAttempts} attempts`}. Retake wait: {course.preview.policy.waitingPeriodHours} hours.</p>
          <p>Questions randomized: {course.preview.policy.randomizeQuestions?'yes':'no'}. Answers randomized: {course.preview.policy.randomizeOptions?'yes':'no'}. Reshuffle on retake: {course.preview.policy.reshuffleOnRetake?'yes':'no'}.</p>
          <p>Correct answers after completion: {course.preview.policy.showAnswersAfterCompletion?'shown':'hidden'}. Signed attestation: {course.preview.policy.attestation.required?'required':'optional'}.</p>
          <blockquote>{course.preview.policy.attestation.statement}</blockquote>
          <p>Certificate: {course.preview.policy.certificate.enabled?'enabled':'disabled'}{course.preview.policy.certificate.validMonths!==null?` · valid for ${course.preview.policy.certificate.validMonths} months`:''}. Renewal: {course.preview.policy.renewal.rule.replace('_',' ')}.</p>
          <p>{course.preview.policy.certificate.wording}</p>
          <h4>Lessons</h4>{course.preview.lessons.map(lesson=><details key={lesson.id}><summary>{lesson.title}</summary><RichLessonContent content={lesson.content}/></details>)}
          <h4>Questions</h4><p>Answer keys and grading rubrics remain private.</p>
          {course.preview.questions.map((question,index)=><details key={question.id}><summary>{index+1}. {question.prompt}</summary>
            <p>{question.kind.replaceAll('_',' ')} · {question.points} points</p>
            {'options' in question&&<ul>{question.options.map(option=><li key={option.id}>{option.text}</li>)}</ul>}
            {'pairs' in question&&<ul>{question.pairs.map(pair=><li key={pair.id}>{pair.left}</li>)}</ul>}
          </details>)}
        </>}
      </details>)}
    </>}
  </section>;
}
