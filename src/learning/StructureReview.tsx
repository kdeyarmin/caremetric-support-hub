import type { GovernedCourse } from "../imports/governedLearningImport";
import type { StructureChange } from "./structureProtocol";

const labels: Record<string, string> = { title: "Title", content: "Lesson text", transcript: "Transcript", estimatedMinutes: "Duration in minutes",
  activityType: "Learning activity", attestationText: "Attestation statement", attestationVersion: "Attestation version" };
export function StructureReview({ material, changes }: { material: GovernedCourse; changes: StructureChange[] }) {
  const lessons = new Map(material.blocks.map(block => [block.id, block.title || "Untitled lesson"]));
  const quizzes = new Map(material.blocks.flatMap(block => block.quiz ? [[block.quiz.id, block.quiz.title] as const] : []));
  const questions = new Map(material.blocks.flatMap(block => block.quiz?.questions.map(question => [question.id, question] as const) ?? []));
  for (const change of changes) {
    if (change.operation === "addLesson") lessons.set(change.blockId, change.title || "Untitled lesson");
    if (change.operation === "editLesson" && Object.hasOwn(change.patch, "title")) lessons.set(change.blockId, change.patch.title || "Untitled lesson");
    if (change.operation === "configureQuiz") quizzes.set(change.quizId, change.title);
  }
  const lesson = (id: string) => lessons.get(id) ?? "Lesson";
  const question = (id: string) => {
    const changed = changes.find((change): change is Extract<StructureChange, { operation: "saveQuestion" }> => change.operation === "saveQuestion" && change.questionId === id);
    return changed?.prompt ?? questions.get(id)?.prompt;
  };
  function fields(values: Record<string, unknown>) {
    return <dl>{Object.entries(values).map(([key, value]) => <div key={key}><dt>{labels[key] ?? key}</dt>
      <dd style={{ whiteSpace: "pre-wrap" }}>{value == null ? "None" : String(value)}</dd></div>)}</dl>;
  }
  return <section aria-label="Review lesson and assessment changes"><h4>Review lessons and assessments</h4>
    <p>All changes below are saved together after confirmation.</p>
    <ol>{changes.map((change, index) => <li key={index}>
      {change.operation === "addLesson" && <><strong>Add {change.blockType === "quiz" ? "assessment" : change.blockType + " lesson"}: {lesson(change.blockId)}</strong>{fields(change.body)}</>}
      {change.operation === "editLesson" && <><strong>Edit {lesson(change.blockId)}</strong>{fields(change.patch)}</>}
      {change.operation === "removeLesson" && <><strong>Remove {lesson(change.blockId)}</strong>
        {change.removedQuestionIds.length > 0 && <><p>Also removes these questions, their answers and explanations:</p>
          <ul>{change.removedQuestionIds.map(id => <li key={id}>{question(id) || "Question"}</li>)}</ul></>}
      </>}
      {change.operation === "reorderLessons" && <><strong>New lesson order</strong><ol>{change.blockIds.map(id => <li key={id}>{lesson(id)}</li>)}</ol></>}
      {change.operation === "configureQuiz" && <><strong>Configure {change.title}</strong>
        <p>{change.kind.replaceAll("_", " ")} · Pass at {change.passingScore}% · {change.maxAttempts == null ? "Unlimited attempts" : `${change.maxAttempts} attempts`}</p>
        <p>Shuffle questions: {change.shuffleQuestions ? "yes" : "no"}. Shuffle answers: {change.shuffleAnswers ? "yes" : "no"}. Reveal answers after attempts: {change.revealsAnswersAfterAttempt ? "yes" : "no"}.</p>
      </>}
      {change.operation === "saveQuestion" && <><strong>{quizzes.get(change.quizId) ?? "Assessment"}: {change.prompt}</strong>
        <p>{change.type.replaceAll("_", " ")} · {change.points} points</p>
        <p>Topic: {[change.topicCode, change.topicLabel].filter(Boolean).join(" · ") || "None"}</p>
        <ol>{change.answers.map(answer => <li key={answer.answerId} style={{ whiteSpace: "pre-wrap" }}>{answer.correct ? "Correct: " : "Incorrect: "}{answer.text}</li>)}</ol>
        <p style={{ whiteSpace: "pre-wrap" }}>Explanation: {change.explanation ?? "None"}</p>
        {change.removedAnswerIds.length > 0 && <><p>Removed answers:</p><ul>{change.removedAnswerIds.map(id => <li key={id}>
          {questions.get(change.questionId)?.options.find(answer => answer.id === id)?.text ?? "Answer"}</li>)}</ul></>}
      </>}
      {change.operation === "removeQuestion" && <><strong>Remove question: {question(change.questionId) || "Question"}</strong><p>Its answers and explanation will also be removed.</p></>}
      {change.operation === "reorderQuestions" && <><strong>New question order in {quizzes.get(change.quizId) ?? "assessment"}</strong>
        <ol>{change.questionIds.map(id => <li key={id}>{question(id) || "Question"}</li>)}</ol></>}
    </li>)}</ol>
    <details><summary>Exact change identifiers and values</summary><pre>{JSON.stringify(changes, null, 2)}</pre></details>
  </section>;
}
