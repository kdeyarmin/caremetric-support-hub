import { useState } from "react";
import type { GovernedCourse } from "../imports/governedLearningImport";
import { activityTypeSchema, blockTypeSchema, structureChangesSchema, type StructureChange } from "./structureProtocol";
import { bodyValue, fieldEditable, move, structureDiff, updateBody, type BodyKey, type Lesson, type Question, type Quiz } from "./structureModel";

function QuestionEditor({ question, busy, onChange }: { question: Question; busy: boolean; onChange: (question: Question) => void }) {
  const change = (patch: Partial<Question>) => onChange({ ...question, ...patch });
  return <fieldset disabled={busy}><legend>Question and complete answer set</legend>
    <label>Question prompt<textarea value={question.prompt} maxLength={12000} onChange={event => change({ prompt: event.target.value })} /></label>
    <label>Question type<select value={question.type} onChange={event => change({ type: event.target.value as Question["type"] })}>
      <option value="single_choice">Single choice</option><option value="multiple_choice">Multiple choice</option><option value="true_false">True or false</option>
    </select></label>
    <label>Question points<input type="number" min={1} max={2147483647} step={1} value={Number.isNaN(question.points) ? "" : question.points}
      onChange={event => change({ points: event.target.value === "" ? Number.NaN : Number(event.target.value) })} /></label>
    <label>Topic code<input value={question.topicCode ?? ""} maxLength={128} onChange={event => change({ topicCode: event.target.value || null })} /></label>
    <label>Topic label<input value={question.topicLabel ?? ""} maxLength={300} onChange={event => change({ topicLabel: event.target.value || null })} /></label>
    <label>Answer explanation<textarea value={question.explanation ?? ""} maxLength={12000} onChange={event => change({ explanation: event.target.value || null })} /></label>
    {question.options.map((answer, index) => <fieldset key={answer.id}><legend>Answer {index + 1}</legend>
      <label>Answer text<textarea value={answer.text} maxLength={12000} onChange={event => change({ options: question.options.map(value => value.id === answer.id ? { ...value, text: event.target.value } : value) })} /></label>
      <label><input type="checkbox" checked={answer.correct} onChange={event => change({ options: question.options.map(value => value.id === answer.id ? { ...value, correct: event.target.checked } : value) })} />Correct answer</label>
      <button type="button" disabled={index === 0} onClick={() => change({ options: move(question.options, index, -1) })}>Move answer up</button>
      <button type="button" disabled={index === question.options.length - 1} onClick={() => change({ options: move(question.options, index, 1) })}>Move answer down</button>
      <button type="button" onClick={() => change({ options: question.options.filter(value => value.id !== answer.id) })}>Remove answer {index + 1}</button>
    </fieldset>)}
    <button type="button" disabled={question.options.length >= 100} onClick={() => change({ options: [...question.options, { id: crypto.randomUUID(), sortOrder: question.options.length, text: "", correct: false }] })}>Add answer</button>
    <p>Each question needs at least two answers. Single choice and true or false need exactly one correct answer.</p>
  </fieldset>;
}
function QuizEditor({ quiz, busy, onChange }: { quiz: Quiz; busy: boolean; onChange: (quiz: Quiz) => void }) {
  const change = (patch: Partial<Quiz>) => onChange({ ...quiz, ...patch });
  return <fieldset disabled={busy}><legend>Assessment settings</legend>
    <label>Assessment title<input value={quiz.title} maxLength={300} onChange={event => change({ title: event.target.value })} /></label>
    <label>Assessment kind<select value={quiz.kind} onChange={event => {
      const kind = event.target.value as Quiz["kind"]; change({ kind, revealsAnswersAfterAttempt: kind === "knowledge_check" && quiz.revealsAnswersAfterAttempt });
    }}><option value="assessment">Assessment</option><option value="knowledge_check">Knowledge check</option><option value="final_exam">Final exam</option></select></label>
    <label>Passing score (%)<input type="number" min={0} max={100} step={1} value={Number.isNaN(quiz.passingScore) ? "" : quiz.passingScore}
      onChange={event => change({ passingScore: event.target.value === "" ? Number.NaN : Number(event.target.value) })} /></label>
    <label>Maximum attempts (blank for unlimited)<input type="number" min={1} max={2147483647} step={1} value={quiz.maxAttempts ?? ""}
      onChange={event => change({ maxAttempts: event.target.value === "" ? null : Number(event.target.value) })} /></label>
    <label><input type="checkbox" checked={quiz.shuffleQuestions} onChange={event => change({ shuffleQuestions: event.target.checked })} />Shuffle questions</label>
    <label><input type="checkbox" checked={quiz.shuffleAnswers} onChange={event => change({ shuffleAnswers: event.target.checked })} />Shuffle answers</label>
    <label><input type="checkbox" disabled={quiz.kind !== "knowledge_check"} checked={quiz.revealsAnswersAfterAttempt} onChange={event => change({ revealsAnswersAfterAttempt: event.target.checked })} />Show answers after a knowledge check</label>
    {quiz.questions.map((question, index) => <details key={question.id} open><summary>Question {index + 1}: {question.prompt || "New question"}</summary>
      <QuestionEditor question={question} busy={busy} onChange={value => change({ questions: quiz.questions.map(current => current.id === value.id ? value : current) })} />
      <button type="button" disabled={index === 0} onClick={() => change({ questions: move(quiz.questions, index, -1) })}>Move question up</button>
      <button type="button" disabled={index === quiz.questions.length - 1} onClick={() => change({ questions: move(quiz.questions, index, 1) })}>Move question down</button>
      <button type="button" onClick={() => change({ questions: quiz.questions.filter(value => value.id !== question.id) })}>Remove question {index + 1}</button>
    </details>)}
    <button type="button" disabled={quiz.questions.length >= 500} onClick={() => change({ questions: [...quiz.questions, {
      id: crypto.randomUUID(), sortOrder: quiz.questions.length, prompt: "", type: "single_choice", points: 1, topicCode: null, topicLabel: null, explanation: null,
      options: [0, 1].map(index => ({ id: crypto.randomUUID(), sortOrder: index, text: "", correct: index === 0 })),
    }] })}>Add question</button>
  </fieldset>;
}
export function StructureEditor({ material, busy, reasonReady, onChange, onPreview }: {
  material: GovernedCourse; busy: boolean; reasonReady: boolean; onChange: () => void; onPreview: (changes: StructureChange[]) => void;
}) {
  const [blocks, setBlocks] = useState<Lesson[]>(() => structuredClone(material.blocks));
  const [newType, setNewType] = useState<Lesson["type"]>("text");
  const changes = structureDiff(material.blocks, blocks), parsed = structureChangesSchema.safeParse(changes);
  function update(next: Lesson[]) { onChange(); setBlocks(next); }
  function edit(block: Lesson) { update(blocks.map(value => value.id === block.id ? block : value)); }
  function field(block: Lesson, key: BodyKey, label: string) {
    if (!fieldEditable(block, key)) return <p key={key}>{label} uses an existing format that must be edited in CareBase.</p>;
    const value = bodyValue(block, key);
    if (key === "estimatedMinutes") return <label key={key}>{label}<input type="number" min={0} max={1440} step={1} value={typeof value === "number" && !Number.isNaN(value) ? value : ""}
      onChange={event => edit(updateBody(block, key, event.target.value === "" ? Number.NaN : Number(event.target.value)))} /></label>;
    if (key === "activityType") return <label key={key}>{label}<select value={typeof value === "string" ? value : ""} onChange={event => edit(updateBody(block, key, event.target.value))}>
      <option value="" disabled>Select an activity</option>{activityTypeSchema.options.map(option => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
    </select></label>;
    return <label key={key}>{label}<textarea value={typeof value === "string" ? value : ""} maxLength={key === "attestationVersion" ? 128 : 12000}
      onChange={event => edit(updateBody(block, key, event.target.value))} /></label>;
  }
  return <section aria-label="Lesson and assessment editor"><h4>Lessons and assessments</h4>
    <p>Add or reorder lessons and edit complete assessments. Removed material is listed in the review before anything is saved.</p>
    <fieldset disabled={busy}><legend>Draft structure</legend>
      {blocks.map((block, index) => <details key={block.id}><summary>{index + 1}. {block.title || "Untitled lesson"} · {block.type}</summary>
        <label>Structure lesson title<input value={block.title ?? ""} maxLength={300} onChange={event => edit({ ...block, title: event.target.value || null })} /></label>
        {field(block, "estimatedMinutes", "Lesson duration (minutes)")}{field(block, "activityType", "Learning activity")}
        {block.type === "text" && field(block, "content", "Lesson content")}
        {block.type === "video" && field(block, "transcript", "Video transcript")}
        {block.type === "attestation" && <>{field(block, "attestationText", "Attestation statement")}{field(block, "attestationVersion", "Attestation version")}</>}
        {["video", "pdf", "scorm"].includes(block.type) && <p>Existing media and package references are preserved. New media lessons remain incomplete until their assets are configured.</p>}
        {block.type === "quiz" && (block.quiz ? <QuizEditor quiz={block.quiz} busy={busy} onChange={quiz => edit({ ...block, quiz })} /> :
          <button type="button" onClick={() => edit({ ...block, quiz: { id: crypto.randomUUID(), title: block.title || "New assessment", kind: "assessment", passingScore: 80,
            maxAttempts: null, shuffleQuestions: false, shuffleAnswers: false, revealsAnswersAfterAttempt: false, questions: [] } })}>Configure assessment</button>)}
        <button type="button" disabled={index === 0} onClick={() => update(move(blocks, index, -1))}>Move lesson up</button>
        <button type="button" disabled={index === blocks.length - 1} onClick={() => update(move(blocks, index, 1))}>Move lesson down</button>
        <button type="button" onClick={() => update(blocks.filter(value => value.id !== block.id))}>Remove lesson {index + 1}</button>
      </details>)}
      <label>New lesson type<select value={newType} onChange={event => setNewType(event.target.value as Lesson["type"])}>
        {blockTypeSchema.options.map(type => <option key={type} value={type}>{type === "quiz" ? "Assessment" : type}</option>)}
      </select></label>
      <button type="button" disabled={blocks.length >= 500} onClick={() => update([...blocks, { id: crypto.randomUUID(), type: newType, sortOrder: blocks.length,
        title: "New lesson", body: {}, documentId: null, videoLocatorSha256: null, quiz: null }])}>Add lesson</button>
    </fieldset>
    {changes.length > 0 && <p>{changes.length} changes prepared. Save up to 20 changes and 24 KB together.</p>}
    {changes.length > 0 && !parsed.success && <p role="alert">Complete the assessment fields, check correct answers and field limits, or reduce this group of changes before previewing.</p>}
    <button type="button" className="button button-secondary" disabled={busy || !reasonReady || !parsed.success}
      onClick={() => { if (parsed.success) onPreview(parsed.data); }}>Preview lesson and assessment changes</button>
  </section>;
}
