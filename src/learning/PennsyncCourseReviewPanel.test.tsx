// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {PennsyncCourseReviewPanel} from './PennsyncCourseReviewPanel';
import {RichLessonContent} from './RichLessonContent';
const revision='a'.repeat(64);
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('reviews an exact preserved revision without writing or publishing',async()=>{
 const fetcher=vi.fn<typeof fetch>(async()=>Response.json({sourceRevision:revision,courses:[{sourceId:'a'.repeat(24),title:'Incomplete course',sourceStatus:'published',issues:[{code:'missing_lessons',message:'No source lessons exist for this course.'}],preview:null}],standaloneModules:6,unmatchedLearners:1}));
 vi.stubGlobal('fetch',fetcher);render(<PennsyncCourseReviewPanel sourceRevision={revision}/>);expect(fetcher).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Review preserved courses'}));await screen.findByRole('status');
 expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({operation:'review',sourceRevision:revision});
 expect(screen.getByText('No source lessons exist for this course.')).toBeTruthy();expect(screen.getByText(/1 unmatched legacy learners remain unlinked/)).toBeTruthy();
 expect(fetcher).toHaveBeenCalledTimes(1);expect(screen.queryByRole('button',{name:/Publish/})).toBeNull();
});
it('refuses mismatched review responses and asks for a current source after a conflict',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({}, {status:409})));render(<PennsyncCourseReviewPanel sourceRevision={revision}/>);
 fireEvent.click(screen.getByRole('button',{name:'Review preserved courses'}));expect((await screen.findByRole('alert')).textContent).toContain('preserved source changed');
 expect(screen.queryByRole('status')).toBeNull();
});
it('renders rich authored content as text, preserving case material without executing HTML',()=>{
 render(<RichLessonContent content={{intro:'<script>unexpected()</script>',sections:[{heading:'Procedure',body:'Body',steps:['First','Second'],example:'Example',do_dont:{do:['Safe'],dont:['Unsafe']}}],case_scenarios:[{title:'Case',situation:'Situation',challenge:'Challenge',guidance:'Guidance',what_could_go_wrong:'Risk',patient_context:'Context'}],clinical_pearl:'Pearl',summary:'Summary'}}/>);
 expect(screen.getByText('<script>unexpected()</script>')).toBeTruthy();expect(document.querySelector('script')).toBeNull();
 for(const label of ['Procedure','Body','First','Second','Example','Safe','Unsafe','Case','Situation','Challenge','Guidance','Risk','Context','Pearl','Summary'])expect(screen.getAllByText(label,{exact:false}).length).toBeGreaterThan(0);
});
