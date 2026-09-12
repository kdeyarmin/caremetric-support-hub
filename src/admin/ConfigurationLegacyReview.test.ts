import {describe,expect,it} from 'vitest';
import {validConfigurationParameters,validConfigurationState} from '../../supabase/functions/_shared/operationalConfiguration';
const target={kind:'release',featureKey:'fixture.release'} as const;
const configured={configured:true,rolloutMode:'cohort',isEnabled:true,owner:'Legacy owner',expiresAt:null,changeReason:'Legacy reason'};
describe('legacy release metadata',()=>{
  it('accepts independently nullable historical owner and reason without inventing replacements',()=>{
    for(const owner of [null,'','Legacy owner'])for(const changeReason of [null,'','Retained\nlegacy reason']){
      expect(validConfigurationState(target,{...configured,owner,changeReason})).toBe(true);
    }
  });
  it('still rejects malformed or unexpected historical metadata',()=>{
    for(const field of ['owner','changeReason'])for(const value of [42,{},[],undefined,'bad\0value','x'.repeat(200001)]){
      expect(validConfigurationState(target,{...configured,[field]:value})).toBe(false);
    }
    expect(validConfigurationState(target,{...configured,extra:'not allowed'})).toBe(false);
  });
  it('retains the all-null unconfigured state and strict ownership on new writes',()=>{
    const unconfigured={configured:false,rolloutMode:null,isEnabled:null,owner:null,expiresAt:null,changeReason:null};
    expect(validConfigurationState(target,unconfigured)).toBe(true);
    for(const [field,value] of Object.entries({rolloutMode:'off',isEnabled:false,owner:'Owner',expiresAt:'2026-09-12T00:00:00Z',changeReason:'Reason'})){
      expect(validConfigurationState(target,{...unconfigured,[field]:value})).toBe(false);
    }
    for(const owner of [null,''])expect(validConfigurationParameters(target,{rolloutMode:'off',isEnabled:false,owner,expiresAt:null})).toBe(false);
    expect(validConfigurationParameters(target,{rolloutMode:'off',isEnabled:false,owner:'Reviewed owner',expiresAt:null})).toBe(true);
  });
});
