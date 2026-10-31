import { requestAdmin } from "../admin/transport";
import { authoringOperationSchema, authoringSourceViewSchema, generatedRegistrationSchema, governedStageResultSchema, projectAuthoringResult, type AuthoringOperation } from "./authoringProtocol";

/** Sends one CareBase authoring operation through the Hub and checks the answer against the exact operation sent. */
export async function runAuthoring(operation: AuthoringOperation) {
  const op = authoringOperationSchema.parse(operation);
  const result = await requestAdmin("learning-authoring", op, new AbortController().signal);
  if (op.operation === "preserve_source") return governedStageResultSchema.parse(result);
  if (op.operation === "register_generated") return generatedRegistrationSchema.parse(result);
  const projected = await projectAuthoringResult(result, op);
  return op.operation === "source" ? authoringSourceViewSchema.parse({ ...authoringSourceViewSchema.parse(result), ...projected }) : projected;
}
