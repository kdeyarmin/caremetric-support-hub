// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../imports/fixtures/governedCourse.json";
import { validateGovernedCourse } from "../imports/governedLearningImport";
import { StructureEditor } from "./StructureEditor";

afterEach(cleanup);
function setup() {
  const material = validateGovernedCourse({ ...fixture, sourceVersionState: "draft" });
  const preview = vi.fn(), changed = vi.fn();
  render(<StructureEditor material={material} busy={false} reasonReady onChange={changed} onPreview={preview} />);
  return { material, preview, changed };
}
it("previews the complete weighted question and explicit removed answers without applying it", () => {
  const { material, preview, changed } = setup();
  fireEvent.change(screen.getByLabelText("Question prompt"), { target: { value: "A revised assessment question?" } });
  fireEvent.change(screen.getByLabelText("Answer explanation"), { target: { value: "The complete clinical explanation." } });
  fireEvent.click(screen.getByRole("button", { name: "Remove answer 3" }));
  expect(preview).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalled();
  const question = material.blocks.find(block => block.quiz)!.quiz!.questions[0]!;
  fireEvent.click(screen.getByRole("button", { name: "Preview lesson and assessment changes" }));
  expect(preview).toHaveBeenCalledOnce();
  expect(preview.mock.calls[0]![0]).toEqual([expect.objectContaining({ operation: "saveQuestion", questionId: question.id,
    points: 101, prompt: "A revised assessment question?", explanation: "The complete clinical explanation.", removedAnswerIds: [question.options[2]!.id],
    answers: question.options.slice(0, 2).map(answer => ({ answerId: answer.id, text: answer.text, correct: answer.correct })),
  })]);
});
it("prevents a changed assessment with no correct answer from being previewed", () => {
  const { preview } = setup();
  for (const checkbox of screen.getAllByLabelText("Correct answer")) if ((checkbox as HTMLInputElement).checked) fireEvent.click(checkbox);
  expect((screen.getByRole("button", { name: "Preview lesson and assessment changes" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("correct answers"); expect(preview).not.toHaveBeenCalled();
});
it("allows adding an incomplete draft lesson and explicitly previews all descendants of a removed assessment", () => {
  const { material, preview } = setup();
  const removed = material.blocks.find(block => block.quiz)!;
  fireEvent.click(screen.getByRole("button", { name: "Remove lesson 2" }));
  fireEvent.change(screen.getByLabelText("New lesson type"), { target: { value: "quiz" } });
  fireEvent.click(screen.getByRole("button", { name: "Add lesson" }));
  const durations = screen.getAllByLabelText("Lesson duration (minutes)");
  fireEvent.change(durations[durations.length - 1]!, { target: { value: "10" } });
  fireEvent.change(durations[durations.length - 1]!, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview lesson and assessment changes" }));
  expect(preview.mock.calls[0]![0]).toEqual([
    { operation: "removeLesson", blockId: removed.id, removedQuestionIds: removed.quiz!.questions.map(question => question.id) },
    expect.objectContaining({ operation: "addLesson", blockType: "quiz", title: "New lesson", body: {} }),
  ]);
});
