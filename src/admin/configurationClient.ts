import {requestAdmin} from './transport';
import {parseConfigurationOperation,projectConfigurationResult,type ConfigurationOperation,type ConfigurationContext,type ConfigurationPreview,
  type ConfigurationResult,type ConfigurationStatus,type ConfigurationCommands} from './configurationProtocol';
export type ConfigurationResponse=ConfigurationContext|ConfigurationPreview|ConfigurationResult|ConfigurationStatus|ConfigurationCommands;
export interface ConfigurationClient {request:(operation:ConfigurationOperation,signal:AbortSignal)=>Promise<ConfigurationResponse>}
export const configurationClient:ConfigurationClient={request:async(operation,signal)=>{
  const parsed=parseConfigurationOperation(operation);return projectConfigurationResult(await requestAdmin('operational-configuration',parsed,signal),parsed);
}};
