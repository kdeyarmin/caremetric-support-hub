import { requestAdmin } from '../admin/transport';
import { distributionOperationSchema,distributionContextSchema,distributionPreviewSchema,type DistributionOperation } from './distributionProtocol';
export async function runDistribution(input: DistributionOperation,signal: AbortSignal){
  const operation=distributionOperationSchema.parse(input);
  const value=await requestAdmin('course-distribution',operation,signal);
  return operation.operation==='context'?distributionContextSchema.parse(value):distributionPreviewSchema.parse(value);
}
