import { requestAdmin } from "../admin/transport";
import { creationOptionsOperationSchema, creationOptionsSchema, projectCreationResult } from "./creationProtocol";

export async function loadCreditTrainingTypes(offset: number, signal: AbortSignal) {
  const operation = creationOptionsOperationSchema.parse({ operation: "creationOptions", offset });
  return creationOptionsSchema.parse(projectCreationResult(await requestAdmin("course-creation", operation, signal), operation));
}
