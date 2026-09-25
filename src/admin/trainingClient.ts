import {requestAdmin} from './transport';
import {parseTrainingOperation,projectTrainingResponse,type TrainingCertificate,type TrainingOperation,type TrainingResponse} from '../../supabase/functions/_shared/trainingProtocol';
export interface TrainingClient { request(operation:TrainingOperation,signal:AbortSignal):Promise<TrainingResponse> }
export const trainingClient:TrainingClient={request:async(operation,signal)=>{
  const parsed=parseTrainingOperation(operation);
  const response=await requestAdmin('training',parsed,signal);
  // The authenticated Hub endpoint already projects the certificate's identity,
  // scoped URL and expiry. Its server clock is authoritative; a workstation's
  // clock must not reject an otherwise valid short-lived download link.
  if(parsed.operation==='certificates.read')return response as TrainingCertificate;
  return projectTrainingResponse(response,parsed);
}};
