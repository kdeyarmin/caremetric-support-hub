import {expect,it} from "vitest";
import {providerContextSchema,providerDateSchema,providerFormPatch,providerOperationSchema,providerPatchSchema,projectProviderResult,verifyProviderPreview,verifyProviderResult} from "./providerPolicyProtocol";
import {nativeAuthoringOperationSchema} from "./authoringProtocol";
import {providerCommand,providerContext,providerCourse,providerPreview,providerResult} from "./testFixtures/provider";
const domain="course.provider.v1" as const;
it("binds all five operations to the provider domain and rejects same-audience authoring confusion",()=>{
  const operations=[{domain,operation:"context",courseId:providerCourse},{domain,operation:"commands",courseId:providerCourse,offset:0},
    {domain,operation:"preview",courseId:providerCourse,requestId:providerCommand,providerContextRevision:"a".repeat(64),patch:{providerFullName:"Updated provider"},reason:providerPreview.reason},
    ...["apply","status"].map(operation=>({domain,operation,commandId:providerCommand,expectedDigest:"b".repeat(64)}))];
  for(const op of operations){expect(providerOperationSchema.safeParse(op).success).toBe(true);expect(nativeAuthoringOperationSchema.safeParse(op).success).toBe(false);
    const {domain:_domain,...wrong}=op;expect(_domain).toBe(domain);expect(providerOperationSchema.safeParse(wrong).success).toBe(false);
    expect(providerOperationSchema.safeParse({...op,actorId:providerCommand}).success).toBe(false);}
});
it("preserves unselected legacy prose and requires explicit clearing and valid dates",()=>{
  expect(providerContextSchema.parse(providerContext).profile!.reviewNotes!.length).toBeGreaterThan(12000);
  expect(providerFormPatch(new Set(["providerFullName"]),{providerFullName:"  Updated provider  ",reviewNotes:providerContext.profile!.reviewNotes!},new Set())).toEqual({providerFullName:"Updated provider"});
  expect(providerFormPatch(new Set(["reviewNotes"]),{},new Set(["reviewNotes"]))).toEqual({reviewNotes:null});
  expect(()=>providerFormPatch(new Set(["providerFullName"]),{},new Set(["providerFullName"]))).toThrow();
  for(const date of ["2026-02-29","2026-02-30","0000-01-01","2026-13-01"])expect(providerDateSchema.safeParse(date).success).toBe(false);
  expect(providerDateSchema.parse("2024-02-29")).toBe("2024-02-29");
  for(const patch of [{},{providerFullName:null},{reviewNotes:" "},{reviewNotes:"Hidden\u0001text"},{signatureRecordedAt:"2026-09-11T00:00:00Z"},{reviewNotes:'{"token":"hidden"}'},{courseAuthor:"https://example.test/?token=secret"}])expect(providerPatchSchema.safeParse(patch).success).toBe(false);
  expect(providerPatchSchema.parse({reviewNotes:"Line one\r\n\tLine two"})).toEqual({reviewNotes:"Line one\r\n\tLine two"});
  expect(providerPatchSchema.safeParse({reviewNotes:"界".repeat(9000)}).success).toBe(false);
});
it("checks exact before/after, coursewide impact and signature time instead of trusting the response",()=>{
  const patch={providerFullName:"Updated provider"};expect(verifyProviderPreview(providerPreview,providerContext,patch,providerPreview.reason)).toEqual(providerPreview);
  for(const change of [{impact:{...providerPreview.impact,legacyFallbackCertificates:"0"}},{signatureTimestampAction:"record"},{changes:[{...providerPreview.changes[0],before:"Another provider"}]},{providerContextRevision:"f".repeat(64)}])
    expect(()=>verifyProviderPreview({...providerPreview,...change},providerContext,patch,providerPreview.reason)).toThrow();
  expect(()=>verifyProviderPreview(providerPreview,providerContext,{...patch,courseAuthor:"New author"},providerPreview.reason)).toThrow();
  expect(verifyProviderResult(providerResult,providerPreview)).toEqual(providerResult);
  expect(()=>verifyProviderResult({...providerResult,providerContextRevision:providerContext.providerContextRevision},providerPreview)).toThrow();
});
it("checks receipt identity, read-only completion and bounded pagination",()=>{
  const status={domain,operation:"status" as const,commandId:providerCommand,expectedDigest:providerPreview.previewDigest};
  expect(projectProviderResult({preview:providerPreview,result:providerResult,canApplyThisSession:false},status)).toMatchObject({result:providerResult});
  for(const value of [{preview:providerPreview,result:providerResult,canApplyThisSession:true},{preview:{...providerPreview,previewDigest:"f".repeat(64)},result:null,canApplyThisSession:false}])expect(()=>projectProviderResult(value,status)).toThrow();
  expect(()=>projectProviderResult({items:[],nextOffset:20},{domain,operation:"commands",courseId:providerCourse,offset:0})).toThrow();
  expect(()=>providerContextSchema.parse({...providerContext,impact:{...providerContext.impact,versionCount:"9223372036854775808"}})).toThrow();
  expect(()=>providerContextSchema.parse({...providerContext,profile:{...providerContext.profile,signatureName:"Missing timestamp"}})).toThrow();
});
