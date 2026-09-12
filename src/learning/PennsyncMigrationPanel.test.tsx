// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {PennsyncMigrationPanel} from './PennsyncMigrationPanel';
const preview={sourceRevision:'a'.repeat(64),headRevision:null,snapshotId:null,replayed:false,summary:{courses:19,modules:23,standaloneModules:6,questions:55,plans:6,planCourses:48,historyRecords:20,unmatchedLegacyLearners:1,ambiguousLegacyLearners:0,sourceReferences:0,brokenReferences:0,catalog:[]}};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('requires review of actual source counts and submits the exact observed revision',async()=>{
 const fetcher=vi.fn<typeof fetch>(async()=>Response.json(preview));vi.stubGlobal('fetch',fetcher);
 render(<PennsyncMigrationPanel/>);expect(fetcher).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Inspect current PennSync source'}));await screen.findByText(/19 courses · 6 standalone modules/);
 expect((screen.getByRole('button',{name:'Preserve current source'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Preserve current source'}));
 await screen.findByRole('status');expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({operation:'preserve',sourceRevision:preview.sourceRevision,expectedHeadRevision:null,reviewed:true});
 expect(screen.getByText(/Unmatched learner history remains preserved/)).toBeTruthy();
});
it('a stale source requires another review and never silently retries a newer revision',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json(preview)).mockResolvedValueOnce(Response.json({}, {status:409}));vi.stubGlobal('fetch',fetcher);
 render(<PennsyncMigrationPanel/>);fireEvent.click(screen.getByRole('button',{name:'Inspect current PennSync source'}));await screen.findByRole('checkbox');
 fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Preserve current source'}));
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('source changed'));
 expect((screen.getByRole('button',{name:'Preserve current source'}) as HTMLButtonElement).disabled).toBe(true);expect(fetcher).toHaveBeenCalledTimes(2);
});
