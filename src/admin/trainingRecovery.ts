import { parseTrainingOperation } from "../../supabase/functions/_shared/trainingProtocol";
import type { TrainingIntent } from "./TrainingCommandReview";

const key = (actorId: string) => `caremetric.training.pending.${actorId}`;
export function loadTrainingIntent(actorId: string): TrainingIntent | null {
  const raw = sessionStorage.getItem(key(actorId));
  if (!raw) return null;
  const saved = JSON.parse(raw) as TrainingIntent;
  const command = parseTrainingOperation(saved.command);
  if (command.operation !== "apply" || typeof saved.title !== "string" || saved.title.length > 200 || !Array.isArray(saved.details) || saved.details.length > 30 || saved.details.some(item => !Array.isArray(item) || item.length !== 2 || item.some(value => typeof value !== "string" || value.length > 1000))) throw new Error("Pending training request is unavailable.");
  return { command, title: saved.title, details: saved.details };
}
export function saveTrainingIntent(actorId: string, intent: TrainingIntent) {
  // A write is dispatched only after its exact retry identity is stored for this Hub actor.
  sessionStorage.setItem(key(actorId), JSON.stringify(intent));
  if (loadTrainingIntent(actorId)?.command.requestId !== intent.command.requestId) throw new Error("Could not retain training request.");
}
export function clearTrainingIntent(actorId: string) { sessionStorage.removeItem(key(actorId)); }
