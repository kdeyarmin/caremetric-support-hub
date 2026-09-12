import type {RichLesson} from './assessmentDocument';

export function RichLessonContent({content}:{content:RichLesson}){
  return <div className="lesson-body">
    {content.intro&&<p>{content.intro}</p>}
    {content.sections?.map((section,index)=><section key={index}><h4>{section.heading}</h4>
      {section.body&&<p>{section.body}</p>}{section.bullets&&<ul>{section.bullets.map((item,i)=><li key={i}>{item}</li>)}</ul>}
      {section.steps&&<ol>{section.steps.map((item,i)=><li key={i}>{item}</li>)}</ol>}
      {section.example&&<p><strong>Practical example: </strong>{section.example}</p>}
      {section.pro_tip&&<p><strong>Practice tip: </strong>{section.pro_tip}</p>}
      {section.warning&&<p><strong>Important: </strong>{section.warning}</p>}
      {section.do_dont?.do&&<><h5>Do this</h5><ul>{section.do_dont.do.map((item,i)=><li key={i}>{item}</li>)}</ul></>}
      {section.do_dont?.dont&&<><h5>Avoid this</h5><ul>{section.do_dont.dont.map((item,i)=><li key={i}>{item}</li>)}</ul></>}
      {section.mnemonic&&<p><strong>Memory aid: </strong>{section.mnemonic}</p>}
      {section.regulation_ref&&<p><strong>Regulatory reference: </strong>{section.regulation_ref}</p>}
    </section>)}
    {content.check_your_understanding&&<section><h4>Check your understanding</h4><ul>{content.check_your_understanding.map((q,i)=><li key={i}>{q}</li>)}</ul></section>}
    {content.case_scenarios?.map((scenario,index)=><section key={index}><h4>{scenario.title}</h4>
      {scenario.patient_context&&<p>{scenario.patient_context}</p>}<p>{scenario.situation}</p>
      {scenario.challenge&&<p><strong>The question: </strong>{scenario.challenge}</p>}
      {scenario.guidance&&<p><strong>Best practice: </strong>{scenario.guidance}</p>}
      {scenario.what_could_go_wrong&&<p><strong>Risk: </strong>{scenario.what_could_go_wrong}</p>}
      {scenario.discussion_questions&&<ul>{scenario.discussion_questions.map((q,i)=><li key={i}>{q}</li>)}</ul>}
    </section>)}
    {content.clinical_pearl&&<p><strong>Clinical pearl: </strong>{content.clinical_pearl}</p>}
    {content.key_takeaways&&<section><h4>Key takeaways</h4><ul>{content.key_takeaways.map((item,i)=><li key={i}>{item}</li>)}</ul></section>}
    {content.summary&&<p><strong>Summary: </strong>{content.summary}</p>}
  </div>;
}
