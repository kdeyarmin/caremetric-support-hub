import {configurationAction,parseConfigurationOperation,sameConfigurationTarget,sameConfigurationState,
  validConfigurationContext,validConfigurationPreview,validConfigurationResult,validConfigurationStatus,validConfigurationCommands,
  type ConfigurationOperation,type ConfigurationContext,type ConfigurationPreview,type ConfigurationResult,
  type ConfigurationStatus,type ConfigurationCommands,type ConfigurationParameters} from '../../supabase/functions/_shared/operationalConfiguration.ts';
export * from '../../supabase/functions/_shared/operationalConfiguration.ts';
const check=(valid:unknown)=>{if(!valid)throw new Error('Operational configuration response mismatch.');};
const sameInstant=(a:string|null,b:string|null)=>a===null?b===null:b!==null&&Date.parse(a)===Date.parse(b);
export function projectConfigurationResult(value:unknown,operation:ConfigurationOperation):ConfigurationContext|ConfigurationPreview|ConfigurationResult|ConfigurationStatus|ConfigurationCommands {
  if(operation.operation==='context'){check(validConfigurationContext(value)&&sameConfigurationTarget(value.target,operation.target));return value as ConfigurationContext;}
  if(operation.operation==='commands'){check(validConfigurationCommands(value,operation.offset));return value as ConfigurationCommands;}
  if(operation.operation==='status'){check(validConfigurationStatus(value)&&value.preview.commandId.toLowerCase()===operation.commandId.toLowerCase()&&value.preview.previewDigest===operation.expectedDigest);return value as ConfigurationStatus;}
  if(operation.operation==='apply'){check(validConfigurationResult(value)&&value.commandId.toLowerCase()===operation.commandId.toLowerCase());return value as ConfigurationResult;}
  if(operation.operation!=='preview')throw new Error('Invalid configuration operation.');
  check(validConfigurationPreview(value));const preview=value as ConfigurationPreview;
  check(sameConfigurationTarget(preview.target,operation.target)&&preview.action===configurationAction(operation.target)
    &&preview.configurationRevision===operation.configurationRevision&&preview.reason===operation.reason);
  const parameters=operation.parameters,after=preview.after;
  if(operation.target.kind==='job')check('enabled' in after&&'enabled' in parameters&&after.enabled===parameters.enabled&&after.reason===operation.reason);
  else if(operation.target.kind==='release')check('rolloutMode' in after&&'rolloutMode' in parameters&&after.configured&&after.rolloutMode===parameters.rolloutMode
    &&after.isEnabled===parameters.isEnabled&&after.owner===parameters.owner&&after.changeReason===operation.reason&&sameInstant(after.expiresAt,parameters.expiresAt));
  else check('isDisabled' in after&&'isDisabled' in parameters&&(parameters.isDisabled?after.configured&&after.isDisabled&&after.reason===operation.reason
    &&sameInstant(after.expiresAt,parameters.expiresAt):!after.configured&&!after.isDisabled&&after.reason===null&&after.expiresAt===null));
  check(new TextEncoder().encode(JSON.stringify(value)).byteLength<=1048576);return preview;
}
export function verifyConfigurationPreview(value:unknown,context:ConfigurationContext,parameters:ConfigurationParameters,reason:string):ConfigurationPreview {
  const op=parseConfigurationOperation({domain:'operations.config.v1',operation:'preview',requestId:'11111111-1111-4111-8111-111111111111',
    target:context.target,configurationRevision:context.configurationRevision,parameters,reason});
  const preview=projectConfigurationResult(value,op) as ConfigurationPreview;
  check(sameConfigurationState(preview.before,context.state)&&Object.keys(preview.impact).length===Object.keys(context.impact).length
    &&Object.entries(context.impact).every(([key,value])=>{const actual=(preview.impact as unknown as Record<string,unknown>)[key];
      return key==='nextBoundaryAt'?sameInstant(actual as string|null,value as string|null):actual===value;}));return preview;
}
export function verifyConfigurationResult(value:unknown,preview:ConfigurationPreview):ConfigurationResult {
  check(validConfigurationResult(value));const result=value as ConfigurationResult;
  check(result.commandId.toLowerCase()===preview.commandId.toLowerCase()&&sameConfigurationTarget(result.target,preview.target)
    &&result.action===preview.action&&sameConfigurationState(result.state,preview.after));return result;
}
