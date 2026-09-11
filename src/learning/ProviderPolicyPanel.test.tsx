// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {requestAdmin} from "../admin/transport";
import {ProviderPolicyPanel} from "./ProviderPolicyPanel";
import {providerCommand,providerContext,providerCourse,providerPreview,providerResult} from "./testFixtures/provider";
vi.mock("../admin/transport",()=>({requestAdmin:vi.fn()}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
function setup({lostApply=false,lostPreview=false,pendingStatus=false,recoveryOnly=false,tamper=false}={}){
  const applied=vi.fn();
  let previews=0,applies=0;
  vi.mocked(requestAdmin).mockImplementation(async(_name,input)=>{
    const op=input as {operation:string};
    if(op.operation==="context")return providerContext;
    if(op.operation==="commands")return {items:[{commandId:providerCommand,expectedDigest:providerPreview.previewDigest,expiresAt:providerPreview.expiresAt,appliedAt:null}],nextOffset:null};
    if(op.operation==="preview"){if(lostPreview&&previews++===0)throw {code:"upstream"};return tamper?{...providerPreview,impact:{...providerPreview.impact,legacyFallbackCertificates:"0"}}:providerPreview;}
    if(op.operation==="apply"){if(lostApply&&applies++===0)throw {code:"upstream"};return providerResult;}
    return {preview:providerPreview,result:recoveryOnly||pendingStatus?null:providerResult,canApplyThisSession:pendingStatus};
  });
  render(<ProviderPolicyPanel courseId={providerCourse} onApplied={applied}/>);return applied;
}
async function loadAndPreview(){
  fireEvent.click(screen.getByRole("button",{name:"Load provider details and saved requests"}));
  fireEvent.click(await screen.findByRole("checkbox",{name:"Change provider name"}));
  fireEvent.change(screen.getByLabelText("New provider name"),{target:{value:"Updated provider"}});
  fireEvent.change(screen.getByLabelText("Reason for changing provider details"),{target:{value:providerPreview.reason}});
  fireEvent.click(screen.getByRole("button",{name:"Preview provider changes"}));
}
it("reviews precise legacy display impact, submits only selected changes and requires explicit confirmation",async()=>{
  const applied=setup();await loadAndPreview();
  const confirm=await screen.findByRole("button",{name:"Confirm provider changes"});expect((confirm as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/9007199254740995 older certificates/)).toBeDefined();
  const input=vi.mocked(requestAdmin).mock.calls.find(call=>(call[1] as {operation:string}).operation==="preview")![1];
  expect(input).toMatchObject({domain:"course.provider.v1",patch:{providerFullName:"Updated provider"}});
  expect(Object.keys((input as {patch:object}).patch)).toEqual(["providerFullName"]);
  expect(applied).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("checkbox",{name:/I reviewed these exact changes/}));fireEvent.click(confirm);
  await screen.findByRole("status");expect(applied).toHaveBeenCalledOnce();
  expect((screen.getByRole("button",{name:"Preview provider changes"}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button",{name:"Load provider details and saved requests"}) as HTMLButtonElement).disabled).toBe(false);
});
it("locks uncertain writes to the saved command until read-only recovery confirms its receipt",async()=>{
  const applied=setup({lostApply:true});await loadAndPreview();await screen.findByRole("button",{name:"Confirm provider changes"});
  fireEvent.click(screen.getByRole("checkbox",{name:/I reviewed these exact changes/}));fireEvent.click(screen.getByRole("button",{name:"Confirm provider changes"}));
  await screen.findByRole("alert");expect((screen.getByRole("button",{name:"Load provider details and saved requests"}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button",{name:"Review saved provider request"}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Check saved provider result"}));await screen.findByRole("status");expect(applied).toHaveBeenCalledOnce();
  expect(vi.mocked(requestAdmin).mock.calls.filter(call=>(call[1] as {operation:string}).operation==="apply")).toHaveLength(1);
  expect(vi.mocked(requestAdmin).mock.calls.at(-1)![1]).toEqual({domain:"course.provider.v1",operation:"status",commandId:providerCommand,expectedDigest:providerPreview.previewDigest});
});
it("new sessions can inspect saved pending reviews but cannot apply them",async()=>{
  setup({recoveryOnly:true});fireEvent.click(screen.getByRole("button",{name:"Load provider details and saved requests"}));
  fireEvent.click(await screen.findByRole("button",{name:"Review saved provider request"}));await screen.findByText(/This session cannot apply that review/);
  expect(screen.queryByRole("button",{name:"Confirm provider changes"})).toBeNull();
});
it("withholds confirmation when a preview hides part of the reviewed impact",async()=>{
  setup({tamper:true});await loadAndPreview();await screen.findByRole("alert");
  await waitFor(()=>expect(screen.queryByRole("button",{name:"Confirm provider changes"})).toBeNull());
});
it("retries a lost preview with the exact original request identity",async()=>{
  setup({lostPreview:true});await loadAndPreview();await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button",{name:"Preview provider changes"}));await screen.findByRole("button",{name:"Confirm provider changes"});
  const previews=vi.mocked(requestAdmin).mock.calls.filter(call=>(call[1] as {operation:string}).operation==="preview");
  expect(previews).toHaveLength(2);expect(previews[1]![1]).toEqual(previews[0]![1]);
});
it("requires another explicit review to apply the same pending command after status recovery",async()=>{
  const applied=setup({lostApply:true,pendingStatus:true});await loadAndPreview();await screen.findByRole("button",{name:"Confirm provider changes"});
  fireEvent.click(screen.getByRole("checkbox",{name:/I reviewed these exact changes/}));fireEvent.click(screen.getByRole("button",{name:"Confirm provider changes"}));await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button",{name:"Check saved provider result"}));
  const confirm=await screen.findByRole("button",{name:"Confirm provider changes"});expect((confirm as HTMLButtonElement).disabled).toBe(true);expect(applied).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox",{name:/I reviewed these exact changes/}));fireEvent.click(confirm);await screen.findByRole("status");
  const applies=vi.mocked(requestAdmin).mock.calls.filter(call=>(call[1] as {operation:string}).operation==="apply");
  expect(applies).toHaveLength(2);expect(applies[1]![1]).toEqual(applies[0]![1]);expect(applied).toHaveBeenCalledOnce();
});
