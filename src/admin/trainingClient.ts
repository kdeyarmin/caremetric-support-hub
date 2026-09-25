import {requestAdmin} from './transport';
import {parseTrainingOperation,projectTrainingResponse,type TrainingOperation,type TrainingResponse} from '../../supabase/functions/_shared/trainingProtocol';
export interface TrainingClient { request(operation:TrainingOperation,signal:AbortSignal):Promise<TrainingResponse> }
export const trainingClient:TrainingClient={request:async(operation,signal)=>{
  const parsed=parseTrainingOperation(operation);
  return projectTrainingResponse(await requestAdmin('training',parsed,signal),parsed);
}};
