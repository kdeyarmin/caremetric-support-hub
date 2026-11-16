// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {ConfigurationPanel} from './ConfigurationPanel';
import {configurationContext as context,configurationPreview as preview,configurationResult as result} from './testFixtures/configuration';
import type {ConfigurationOperation} from './configurationProtocol';
vi.mock('./transport',()=>({requestAdmin:vi.fn()}));
afterEach(cleanup);
function fixture(){
  const state={losePreview:false,loseApply:false,newSession:false,pending:false,expired:false},onApplied=vi.fn();
  const request=vi.fn(async(operation:ConfigurationOperation)=>{
    if(operation.operation==='context')return context;
    if(operation.operation==='commands')return {items:[{commandId:preview.commandId,expectedDigest:preview.previewDigest,expiresAt:preview.expiresAt,appliedAt:null}],nextOffset:null};
    if(operation.operation==='preview'){if(state.losePreview)throw Error('private');return state.expired?{...preview,expiresAt:'2000-01-01T00:00:00Z'}:preview;}
    if(operation.operation==='apply'){if(state.loseApply)throw Error('unknown');return result;}
    return {preview,result:state.pending?null:result,canApplyThisSession:state.pending&&!state.newSession};
  });
  render(<ConfigurationPanel target={context.target} label="Fixture job" client={{request}} onApplied={onApplied} onClose={vi.fn()}/>);
  return {state,request,onApplied};
}
async function review(){
  fireEvent.click(screen.getByRole('button',{name:'Load current settings'}));await screen.findByText('Current settings');
  fireEvent.click(screen.getByRole('checkbox',{name:'Set job stop switch'}));fireEvent.change(screen.getByLabelText('Reason for change'),{target:{value:preview.reason}});
  fireEvent.click(screen.getByRole('button',{name:'Review configuration change'}));await screen.findByText('Reviewed change');
}
it('requires exact review confirmation before invoking a native change',async()=>{
  const f=fixture();await review();const apply=screen.getByRole('button',{name:'Apply reviewed configuration'});expect(apply.matches(":disabled")).toBe(true);
  expect(f.request.mock.calls.some(([op])=>op.operation==='apply')).toBe(false);
  fireEvent.click(screen.getByRole('checkbox',{name:'I reviewed this exact configuration change.'}));fireEvent.click(apply);
  await waitFor(()=>expect(f.onApplied).toHaveBeenCalledTimes(1));expect(f.request.mock.calls.filter(([op])=>op.operation==='apply')).toHaveLength(1);
});
it('locks unknown outcomes to one saved command and recovers without another apply',async()=>{
  const f=fixture();f.state.loseApply=true;await review();fireEvent.click(screen.getByRole('checkbox',{name:'I reviewed this exact configuration change.'}));
  fireEvent.click(screen.getByRole('button',{name:'Apply reviewed configuration'}));await screen.findByRole('alert');
  expect(screen.getByRole('button',{name:'Load current settings'}).matches(":disabled")).toBe(true);expect(screen.getByLabelText('Reason for change').matches(":disabled")).toBe(true);
  expect(screen.getByRole('button',{name:'Close settings'}).matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Check saved result'}));await waitFor(()=>expect(f.onApplied).toHaveBeenCalledTimes(1));
  expect(f.request.mock.calls.filter(([op])=>op.operation==='apply')).toHaveLength(1);
});
it('new-session pending recovery is read-only',async()=>{
  const f=fixture();f.state.loseApply=true;f.state.pending=true;f.state.newSession=true;await review();
  fireEvent.click(screen.getByRole('checkbox',{name:'I reviewed this exact configuration change.'}));fireEvent.click(screen.getByRole('button',{name:'Apply reviewed configuration'}));
  await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Check saved result'}));await screen.findByText(/belongs to an earlier session/);
  expect(screen.getByRole('button',{name:'Apply reviewed configuration'}).matches(":disabled")).toBe(true);expect(f.onApplied).not.toHaveBeenCalled();
});
it('same-session pending recovery requires a new explicit confirmation',async()=>{
  const f=fixture();f.state.loseApply=true;f.state.pending=true;await review();
  fireEvent.click(screen.getByRole('checkbox',{name:'I reviewed this exact configuration change.'}));fireEvent.click(screen.getByRole('button',{name:'Apply reviewed configuration'}));
  await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Check saved result'}));await screen.findByText(/has not been applied/);
  expect(screen.getByRole('button',{name:'Apply reviewed configuration'}).matches(":disabled")).toBe(true);f.state.loseApply=false;
  fireEvent.click(screen.getByRole('checkbox',{name:'I reviewed this exact configuration change.'}));fireEvent.click(screen.getByRole('button',{name:'Apply reviewed configuration'}));
  await waitFor(()=>expect(f.onApplied).toHaveBeenCalledTimes(1));const applies=f.request.mock.calls.filter(([op])=>op.operation==='apply');
  expect(applies).toHaveLength(2);expect(applies[0][0]).toEqual(applies[1][0]);
});
it('lost preview retries retain the same request identifier',async()=>{
  const f=fixture();f.state.losePreview=true;fireEvent.click(screen.getByRole('button',{name:'Load current settings'}));await screen.findByText('Current settings');
  fireEvent.click(screen.getByRole('checkbox',{name:'Set job stop switch'}));fireEvent.change(screen.getByLabelText('Reason for change'),{target:{value:preview.reason}});
  fireEvent.click(screen.getByRole('button',{name:'Review configuration change'}));await screen.findByRole('alert');f.state.losePreview=false;
  fireEvent.click(screen.getByRole('button',{name:'Review configuration change'}));await screen.findByText('Reviewed change');
  const previews=f.request.mock.calls.filter(([op])=>op.operation==='preview');expect(previews).toHaveLength(2);expect(previews[0][0]).toEqual(previews[1][0]);
});
it('expired reviews retain recovery but cannot be applied',async()=>{
  const f=fixture();f.state.expired=true;await review();await screen.findByText(/This review expired/);
  expect(screen.getByRole('button',{name:'Apply reviewed configuration'}).matches(':disabled')).toBe(true);
  expect(screen.getByRole('button',{name:'Check saved result'}).matches(':disabled')).toBe(false);
  expect(f.request.mock.calls.some(([op])=>op.operation==='apply')).toBe(false);
});
it('clearing an expired feature stop sends no new expiry and retains historical values in review',async()=>{
  const target={kind:'featureKill' as const,featureKey:'fixture',organizationId:null};
  const state={configured:true,isDisabled:true,reason:'Historical reason',expiresAt:'2000-01-01T00:00:00Z'};
  const impact={kind:'feature' as const,definitionActive:true,organizationName:null,globalKillSwitchActive:false,organizationKillSwitchCount:'0',retainedCohortCount:'0',retainedMembershipCount:'0',nextBoundaryAt:null};
  const source={target,displayName:'Feature',configurationRevision:context.configurationRevision,state,impact};
  const request=vi.fn(async(op:ConfigurationOperation)=>{
    if(op.operation==='context')return source;if(op.operation==='commands')return {items:[],nextOffset:null};
    return {...preview,target,action:'operations.setFeatureKillSwitch' as const,before:state,after:{configured:false,isDisabled:false,reason:null,expiresAt:null},impact};
  });
  render(<ConfigurationPanel target={target} label="Feature" client={{request}} onApplied={vi.fn()} onClose={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Load current settings'}));await screen.findByText('Current settings');
  fireEvent.click(screen.getByRole('checkbox',{name:'Stop this feature'}));fireEvent.change(screen.getByLabelText('Reason for change'),{target:{value:preview.reason}});
  expect(screen.queryByLabelText('Expiry with time zone (optional)')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Review configuration change'}));await screen.findByText('Reviewed change');
  const sent=request.mock.calls.find(([op])=>op.operation==='preview')![0];expect(sent).toMatchObject({parameters:{isDisabled:false,expiresAt:null}});
  expect(screen.getAllByText('2000-01-01T00:00:00Z').length).toBeGreaterThan(0);
});
it('a review after an expired one is a new request, so the application cannot hand back the expired review',async()=>{
  const f=fixture();f.state.expired=true;await review();await screen.findByText(/This review expired/);
  f.state.expired=false;
  fireEvent.click(screen.getByRole('button',{name:'Load current settings'}));await screen.findByText('Current settings');
  fireEvent.click(screen.getByRole('checkbox',{name:'Set job stop switch'}));fireEvent.change(screen.getByLabelText('Reason for change'),{target:{value:preview.reason}});
  fireEvent.click(screen.getByRole('button',{name:'Review configuration change'}));await screen.findByText('Reviewed change');
  const previews=f.request.mock.calls.filter(([op])=>op.operation==='preview').map(([op])=>op as Extract<ConfigurationOperation,{operation:'preview'}>);
  expect(previews).toHaveLength(2);expect(previews[1].requestId).not.toBe(previews[0].requestId);
});
it('loads a cohort release as not enabled globally, and says a change replaces the cohort',async()=>{
  const target={kind:'release' as const,featureKey:'fixture'};
  const state={configured:true,rolloutMode:'cohort' as const,isEnabled:true,owner:'Owner',expiresAt:null,changeReason:'Pilot'};
  const impact={kind:'feature' as const,definitionActive:true,organizationName:null,globalKillSwitchActive:false,organizationKillSwitchCount:'0',retainedCohortCount:'2',retainedMembershipCount:'4',nextBoundaryAt:null};
  const request=vi.fn(async(op:ConfigurationOperation)=>op.operation==='context'?{target,displayName:'Release',configurationRevision:context.configurationRevision,state,impact}:{items:[],nextOffset:null});
  render(<ConfigurationPanel target={target} label="Release" client={{request}} onApplied={vi.fn()} onClose={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Load current settings'}));await screen.findByText('Current settings');
  expect((screen.getByRole('checkbox',{name:'Enable release globally'}) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByRole('note').textContent).toMatch(/rolled out to a cohort/);
});
