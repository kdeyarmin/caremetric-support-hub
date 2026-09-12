import {describe,it,expect} from 'vitest';
import {parseConfigurationOperation,projectConfigurationResult,verifyConfigurationPreview,verifyConfigurationResult,validConfigurationState} from './configurationProtocol';
import {configurationContext as context,configurationPreview as preview,configurationResult as result} from './testFixtures/configuration';
const domain='operations.config.v1' as const;
describe('operational configuration contract',()=>{
  it('rejects new actor, dispatch and cohort authority at the closed input boundary',()=>{
    const op={domain,operation:'preview',requestId:preview.commandId,target:context.target,configurationRevision:context.configurationRevision,parameters:{enabled:true},reason:preview.reason};
    expect(parseConfigurationOperation(op)).toEqual(op);
    for(const value of [{...op,actorId:preview.commandId},{...op,operation:'dispatch'},{...op,parameters:{enabled:true,cohorts:[]}},{...op,domain:'course.provider.v1'},
      {...op,target:{kind:'release',featureKey:'fixture'},parameters:{rolloutMode:'cohort',isEnabled:true,owner:'Owner',expiresAt:null}}])expect(()=>parseConfigurationOperation(value)).toThrow();
  });
  it('binds preview before, after, source and retained policy impact to the actual reviewed state',()=>{
    expect(verifyConfigurationPreview(preview,context,{enabled:true},preview.reason)).toEqual(preview);
    for(const value of [{...preview,before:{enabled:true,reason:null}},{...preview,after:{enabled:false,reason:preview.reason}},
      {...preview,impact:{...preview.impact,killSwitchCanStop:false}},{...preview,configurationRevision:'d'.repeat(64)},
      {...preview,target:{kind:'job',jobKey:'other'}}])expect(()=>verifyConfigurationPreview(value,context,{enabled:true},preview.reason)).toThrow();
  });
  it('accepts native cleared stop semantics while retaining old expiry only in history',()=>{
    const target={kind:'featureKill' as const,featureKey:'fixture',organizationId:null};
    expect(validConfigurationState(target,{configured:false,isDisabled:false,reason:null,expiresAt:null})).toBe(true);
    expect(validConfigurationState(target,{configured:false,isDisabled:false,reason:'historical',expiresAt:'2026-10-01T00:00:00Z'})).toBe(false);
  });
  it('binds saved results to original command and reviewed after state and forbids recovered apply authority',()=>{
    expect(verifyConfigurationResult(result,preview)).toEqual(result);
    expect(()=>verifyConfigurationResult({...result,state:{enabled:false,reason:null}},preview)).toThrow();
    const op=parseConfigurationOperation({domain,operation:'status',commandId:preview.commandId,expectedDigest:preview.previewDigest});
    expect(projectConfigurationResult({preview,result,canApplyThisSession:false},op)).toEqual({preview,result,canApplyThisSession:false});
    for(const value of [{preview,result,canApplyThisSession:true},{preview,result:{...result,replayed:true},canApplyThisSession:false},
      {preview:{...preview,previewDigest:'d'.repeat(64)},result:null,canApplyThisSession:false}])expect(()=>projectConfigurationResult(value,op)).toThrow();
  });
  it('rejects truncated pages with claimed continuation and repeated command identities',()=>{
    const item={commandId:preview.commandId,expectedDigest:preview.previewDigest,expiresAt:preview.expiresAt,appliedAt:null};
    const op=parseConfigurationOperation({domain,operation:'commands',target:context.target,offset:0});
    expect(()=>projectConfigurationResult({items:[item],nextOffset:20},op)).toThrow();
    expect(()=>projectConfigurationResult({items:[item,item],nextOffset:null},op)).toThrow();
  });
});
