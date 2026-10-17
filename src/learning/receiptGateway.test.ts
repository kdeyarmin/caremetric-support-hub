import { describe, expect, it, vi } from "vitest";
import { createAdminGateway, GatewayError } from "../../supabase/functions/_shared/adminGateway";
import { createLearningReceiptProxy } from "../../supabase/functions/learning-receipts/handler";
import { learningReceiptSchema } from "./receiptProtocol";

const id = (n: number) => `abc00000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const actor = () => ({ user_id:id(1),role:"platform_admin",aal:"aal2",session_id:id(2),session_started_at:new Date(Date.now()-60000).toISOString(),assurance_expires_at:new Date(Date.now()+60000).toISOString() });
const json = (value: unknown,status=200) => new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}});
const request = (body:unknown={},signal?:AbortSignal) => new Request("https://hub.test/receipt",{method:"POST",headers:{Authorization:"Bearer a.b.c","Content-Type":"application/json"},body:JSON.stringify(body),signal});
const sha = "a".repeat(64);
const receipt = () => learningReceiptSchema.parse({contract:"caremetric.learning-receipt.v1",source:"carebase",eventId:id(3),kind:"completed",sequence:1,mappingId:id(4),assignmentId:id(5),sourceCourseId:id(6),sourceVersionId:id(7),mappingRevision:sha,assignmentRevision:sha,completionRevision:sha,hubTenantId:id(8),hubUserId:id(9),completedAt:"2026-09-11T15:00:00Z",evidenceSha256:sha,finalExamScore:90,certificate:{id:id(10),issuedAt:"2026-09-11T15:00:00Z",expiresAt:null,providerEvidenceSha256:sha},credits:[],attestations:[],quizEvidenceSha256:sha,renewalEvidenceSha256:sha});

describe("trusted gateway execution",()=>{
  it("projects coordinator results and performs no target call",async()=>{
    const fetcher=vi.fn(async()=>json(actor()));
    const gateway=createAdminGateway({publishableKey:"fixture",fetcher:fetcher as typeof fetch},{authorizationRpc:"authorize_platform_admin",parse:v=>v,execute:async()=>({count:1,secret:"private"}),project:v=>({count:(v as {count:number}).count})});
    expect(await (await gateway(request())).json()).toEqual({count:1}); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects ambiguous execution paths",()=>{
    // @ts-expect-error Deliberately malformed trusted configuration.
    expect(()=>createAdminGateway({publishableKey:"fixture"},{authorizationRpc:"authorize_platform_admin",parse:v=>v,target:()=>({endpoint:null,body:{}}),execute:async()=>({}),project:v=>v})).toThrow("Exactly one");
  });
  for(const result of [new Response("private"),{body:"x".repeat(1048577)}]) it("rejects unbounded or raw results",async()=>{
    const gateway=createAdminGateway({publishableKey:"fixture",fetcher:vi.fn(async()=>json(actor())) as typeof fetch},{authorizationRpc:"authorize_platform_admin",parse:v=>v,execute:async()=>result,project:v=>v});
    expect((await gateway(request())).status).toBe(503);
  });
  it("bounds projection output too",async()=>{
    const gateway=createAdminGateway({publishableKey:"fixture",fetcher:vi.fn(async()=>json(actor())) as typeof fetch},{authorizationRpc:"authorize_platform_admin",parse:v=>v,execute:async()=>({}),project:()=>({body:"x".repeat(1048577)})});
    expect((await gateway(request())).status).toBe(503);
  });
  it("aborts a coordinator that never settles",async()=>{
    const controller=new AbortController(); const gateway=createAdminGateway({publishableKey:"fixture",fetcher:vi.fn(async()=>json(actor())) as typeof fetch},{authorizationRpc:"authorize_platform_admin",parse:v=>v,execute:async()=>{controller.abort();return new Promise(()=>{});},project:v=>v});
    expect((await gateway(request({},controller.signal))).status).toBe(503);
  });
  it("sanitizes failures and allows only declared safe command errors",async()=>{
    for(const error of [new Error("private password"),new GatewayError("conflict")]) {
      const gateway=createAdminGateway({publishableKey:"fixture",fetcher:vi.fn(async()=>json(actor())) as typeof fetch},{authorizationRpc:"authorize_platform_admin",commandErrors:true,parse:v=>v,execute:async()=>{throw error;},project:v=>v});
      const response=await gateway(request()); expect(await response.json()).toEqual({error:{code:error instanceof GatewayError?"conflict":"upstream"}});
    }
  });
});
describe("receipt coordinator",()=>{
  const fixture=(respond:(name:string,body:Record<string,unknown>)=>Response|Promise<Response>)=>{
    const calls:Array<{name:string,body:Record<string,unknown>}>=[];
    const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      expect(init?.redirect).toBe("manual"); expect(init?.signal).toBeInstanceOf(AbortSignal);
      const url=new URL(String(input)); const name=url.pathname.split("/").at(-1)!; const body=JSON.parse(String(init?.body));
      calls.push({name,body});
      if(name==="authorize_platform_command") return json(actor());
      if(name==="receipt") {expect(url.origin).toBe("https://cmcarebase.com");expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer a.b.c");}
      else {expect(url.origin).toBe("https://xgauehtwksmnoqhgqegm.supabase.co");expect(body.p_actor_id).toBe(id(1));expect(body.p_session_id).toBe(id(2));}
      return respond(name,body);
    });
    return {calls,handler:createLearningReceiptProxy({publishableKey:"fixture",serviceKey:"sb_secret_fixture",fetcher:fetcher as typeof fetch})};
  };
  it("verifies native identity before creating a separate canonical tenant",async()=>{
    const f=fixture((name)=>name==="receipt"?json({organizationId:id(11),employeeId:id(12),profileId:id(13),email:"must drop"}):json({hubTenantId:id(8),hubUserId:id(9),nativeOrganizationId:id(11),nativeEmployeeId:id(12),nativeProfileId:id(13),secret:"must drop"}));
    const response=await f.handler(request({operation:"provision_access",nativeOrganizationId:id(11),nativeEmployeeId:id(12),hubTenantId:id(8),tenantName:"Tenant",hubUserId:id(9)}));
    expect(response.status).toBe(200);expect(await response.text()).not.toContain("must drop");expect(f.calls.map(c=>c.name)).toEqual(["authorize_platform_command","receipt","provision_learning_receipt_access"]);
  });
  it("never provisions Hub access on a mismatched native identity",async()=>{
    const f=fixture(()=>json({organizationId:id(99),employeeId:id(12),profileId:id(13)}));
    expect((await f.handler(request({operation:"provision_access",nativeOrganizationId:id(11),nativeEmployeeId:id(12),hubTenantId:id(8),tenantName:"Tenant",hubUserId:id(9)}))).status).toBe(503);expect(f.calls).toHaveLength(2);
  });
  it("does not activate a mapping when native provisioning fails",async()=>{
    const f=fixture(name=>name==="prepare_learning_receipt_mapping"?json({mappingId:id(4),organizationId:id(11),employeeId:id(12),hubTenantId:id(8),hubUserId:id(9),courseId:id(6),versionId:id(7),sourceRevision:sha}):json({error:{code:"conflict"}},409));
    expect((await f.handler(request({operation:"provision",mappingId:id(4),sourceSnapshotId:id(14),nativeOrganizationId:id(11),nativeEmployeeId:id(12),hubTenantId:id(8),hubUserId:id(9)}))).status).toBe(409);expect(f.calls.some(c=>c.name==="set_learning_receipt_mapping_state")).toBe(false);
  });
  it("revokes Hub acceptance before calling native",async()=>{
    const f=fixture(()=>json(null)); expect((await f.handler(request({operation:"revoke",mappingId:id(4)}))).status).toBe(200);
    expect(f.calls.map(c=>c.name)).toEqual(["authorize_platform_command","set_learning_receipt_mapping_state","receipt"]);
  });
  it("acknowledges only after exact evidence has been stored",async()=>{
    const payload=JSON.stringify(receipt()); const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(payload))),b=>b.toString(16).padStart(2,"0")).join("");
    const f=fixture((name,body)=>name==="receipt"&&body.operation==="list"?json([{eventId:id(3),payload,sourceDigest:hash,state:"pending",reason:null}]):name==="ingest_learning_receipt"?json({eventId:id(3),accepted:true,replayed:true}):json({success:true}));
    expect(await (await f.handler(request({operation:"reconcile",limit:10}))).json()).toEqual({accepted:1,quarantined:0,failed:0,quarantineDetails:[],retryEvents:[]});
    expect(f.calls.map(c=>c.name)).toEqual(["authorize_platform_command","receipt","ingest_learning_receipt","receipt"]);expect(f.calls.at(-1)?.body.operation).toBe("acknowledge");
  });
  it("does not ACK tampered or quarantined payloads",async()=>{
    const f=fixture(()=>json([{eventId:id(3),payload:JSON.stringify(receipt()),sourceDigest:sha,state:"pending",reason:null},{eventId:id(15),payload:"private invalid payload",sourceDigest:sha,state:"quarantined",reason:"policy_drift"}]));
    expect(await (await f.handler(request({operation:"reconcile",limit:10}))).json()).toEqual({accepted:0,quarantined:1,failed:1,quarantineDetails:[{eventId:id(15),reason:"policy_drift"}],retryEvents:[id(3)]});expect(f.calls).toHaveLength(2);
  });
  it("rejects a native batch larger than the requested limit before any write",async()=>{
    const f=fixture(()=>json([3,4].map(n=>({eventId:id(n),payload:JSON.stringify(receipt()),sourceDigest:sha,state:"pending",reason:null}))));
    expect((await f.handler(request({operation:"reconcile",limit:1}))).status).toBe(503);expect(f.calls).toHaveLength(2);
  });
});
