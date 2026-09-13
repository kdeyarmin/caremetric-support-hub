// @vitest-environment jsdom
import type {ReactNode} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {JobRecords} from './OperationalRecords';

const fixture=vi.hoisted(()=>({job:{
  jobKey:'fixture.external',displayName:'Fixture job',description:null,executionKind:'external',schedule:null,
  isCritical:false,retryMode:'none',lastStatus:null,lastAttemptAt:null,lastSuccessAt:null,lastDurationMs:null,
  hasError:false,isStale:null,nextExpectedAt:null,attemptedCount:null,succeededCount:null,failedCount:null,
  killSwitchEnabled:false,killSwitchCanStop:false,
}}));
// Isolate the row's permission/control rendering; transport paging has separate tests.
vi.mock('./PagedRecords',()=>({PagedRecords:({render:row}:{render:(value:typeof fixture.job)=>ReactNode})=><table><tbody><tr>{row(fixture.job)}</tr></tbody></table>}));
afterEach(()=>{cleanup();fixture.job.killSwitchCanStop=false;});
it('never offers an effective stop action for a non-stoppable native job',()=>{
  const onConfigure=vi.fn();render(<JobRecords onConfigure={onConfigure}/>);
  expect(screen.getByText('Switch cannot stop this job')).toBeTruthy();
  const button=screen.getByRole('button',{name:'Configure job stop'}) as HTMLButtonElement;
  expect(button.disabled).toBe(true);fireEvent.click(button);expect(onConfigure).not.toHaveBeenCalled();
});
it('opens the exact target only when native stop support is available',()=>{
  fixture.job.killSwitchCanStop=true;const onConfigure=vi.fn();render(<JobRecords onConfigure={onConfigure}/>);
  const button=screen.getByRole('button',{name:'Configure job stop'}) as HTMLButtonElement;
  expect(button.disabled).toBe(false);fireEvent.click(button);
  expect(onConfigure).toHaveBeenCalledExactlyOnceWith({kind:'job',jobKey:'fixture.external'},'Fixture job');
});
it('retains the workspace-wide busy or authority guard even for stoppable jobs',()=>{
  fixture.job.killSwitchCanStop=true;const onConfigure=vi.fn();render(<JobRecords onConfigure={onConfigure} controlsDisabled/>);
  const button=screen.getByRole('button',{name:'Configure job stop'}) as HTMLButtonElement;
  expect(button.disabled).toBe(true);fireEvent.click(button);expect(onConfigure).not.toHaveBeenCalled();
});
