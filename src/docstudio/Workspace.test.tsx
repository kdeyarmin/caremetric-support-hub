// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {DocStudioWorkspace} from './Workspace';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('DocStudio authoring review',()=>{
 it('keeps a failed write on the same reviewed request instead of creating another draft',async()=>{
  const writes:unknown[]=[];const requestId='12345678-1234-4234-8234-123456789012',intentId='22345678-1234-4234-8234-123456789012';
  vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
   if(url==='/api/docstudio')return Response.json({products:[{slug:'carebase',name:'CareBase'}],projects:[],workerReady:false,maxVideoBytes:26214400});
   if(url==='/api/docstudio/preview') {const body=JSON.parse(options!.body as string);return Response.json({id:intentId,requestId,operation:'create',projectId:body.projectId,expectedRevision:0,title:body.draft.title,products:['carebase'],expiresAt:'2026-09-12T00:00:00Z'});}
   if(url==='/api/docstudio/apply'){writes.push(JSON.parse(options!.body as string));return Response.json({error:'Synthetic lost response'},{status:503});}
   throw new Error('Unexpected request');
  }));
  render(<MemoryRouter><DocStudioWorkspace/></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button',{name:'New article'}));
  fireEvent.change(screen.getByLabelText('Title'),{target:{value:'Shared guide'}});
  fireEvent.change(screen.getByLabelText('Summary'),{target:{value:'A useful guide.'}});
  fireEvent.change(screen.getByLabelText('Article (Markdown)'),{target:{value:'# Shared guide\n'}});
  fireEvent.click(screen.getByLabelText('CareBase'));
  fireEvent.click(screen.getByRole('button',{name:'Review draft changes'}));
  const confirm=await screen.findByRole('button',{name:'Confirm reviewed action'});expect(confirm.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByLabelText('I reviewed the exact content shown above and approve this action.'));fireEvent.click(confirm);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button',{name:'Retry the same reviewed action'}));
  await waitFor(()=>expect(writes).toHaveLength(2));expect(writes[1]).toEqual(writes[0]);
  expect(screen.getByRole('button',{name:'Back to draft'}).hasAttribute('disabled')).toBe(true);
 });
 it('opens a new article targeted to the application named in the link',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
   if(url==='/api/docstudio')return Response.json({products:[{slug:'carebase',name:'CareBase'},{slug:'advisors',name:'Healthcare Advisors'}],projects:[],workerReady:false,maxVideoBytes:26214400});
   throw new Error('Unexpected request');
  }));
  render(<MemoryRouter initialEntries={['/docstudio?product=advisors']}><DocStudioWorkspace/></MemoryRouter>);
  const advisors=await screen.findByLabelText('Healthcare Advisors') as HTMLInputElement;
  expect(advisors.checked).toBe(true);
  expect((screen.getByLabelText('CareBase') as HTMLInputElement).checked).toBe(false);
  expect(screen.getByLabelText('Article (Markdown)')).toBeTruthy();
 });
});
