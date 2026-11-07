/**
 * The order a learner sees a quiz's questions in. Learners may retake a quiz as many times as they need, so each attempt shows the
 * questions in a new order. The order is derived from the attempt (enrollment, quiz and attempt number), not drawn at random while
 * rendering, so it stays the same on screen until the attempt is submitted and is the same again after a reload.
 * Grading is by question id, so the order never affects a score.
 */
export function questionOrder<T extends { id: string }>(questions: readonly T[], attempt: { enrollmentId: string; unitId: string; attemptNumber: number }): T[] {
  const random = generator(`${attempt.enrollmentId}:${attempt.unitId}:${attempt.attemptNumber}`);
  const order = [...questions];
  for (let index = order.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [order[index], order[other]] = [order[other], order[index]];
  }
  return order;
}

// A small seeded generator (a 32-bit FNV-1a hash of the seed driving mulberry32): plenty for ordering a handful of questions.
function generator(seed: string): () => number {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) state = Math.imul(state ^ seed.charCodeAt(index), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
