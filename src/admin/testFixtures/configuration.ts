import type {ConfigurationContext,ConfigurationPreview,ConfigurationResult} from '../configurationProtocol';
export const configurationContext:ConfigurationContext={target:{kind:'job',jobKey:'fixture.job'},displayName:'Fixture job',configurationRevision:'a'.repeat(64),
  state:{enabled:false,reason:null},impact:{kind:'job',isActive:true,executionKind:'worker',killSwitchCanStop:true}};
export const configurationPreview:ConfigurationPreview={commandId:'a1000000-0000-4000-8000-000000000001',target:configurationContext.target,
  action:'operations.setJobKillSwitch',reason:'Pause the reviewed fixture job',configurationRevision:configurationContext.configurationRevision,
  previewDigest:'b'.repeat(64),expiresAt:'2099-01-01T00:00:00Z',before:configurationContext.state,after:{enabled:true,reason:'Pause the reviewed fixture job'},impact:configurationContext.impact};
export const configurationResult:ConfigurationResult={commandId:configurationPreview.commandId,target:configurationContext.target,action:configurationPreview.action,
  configurationRevision:'c'.repeat(64),appliedAt:'2026-09-12T00:00:00Z',replayed:false,state:configurationPreview.after};
