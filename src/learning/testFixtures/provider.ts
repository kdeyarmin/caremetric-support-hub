import type {ProviderContext,ProviderPreview,ProviderResult} from "../providerPolicyProtocol";
export const providerCourse="11111111-1111-4111-8111-111111111111";
export const providerCommand="22222222-2222-4222-8222-222222222222";
export const providerContext:ProviderContext={courseId:providerCourse,courseTitle:"Reviewed course",courseStatus:"published",providerContextRevision:"a".repeat(64),
  profile:{id:"33333333-3333-4333-8333-333333333333",providerFullName:"Original provider",courseAuthor:null,signatureName:null,signatureRecordedAt:null,contentVersion:null,lastClinicalReviewDate:null,reviewedBy:null,nextReviewDue:null,regulationReviewDate:null,reviewNotes:"Legacy notes ".repeat(2000)},
  impact:{versionCount:"9007199254740993",legacyFallbackCertificates:"9007199254740995",governedDrafts:[{versionId:"44444444-4444-4444-8444-444444444444",title:"Next draft",aiGenerated:true,reviewInvalidated:true}]}};
export const providerPreview:ProviderPreview={commandId:providerCommand,courseId:providerCourse,action:"learning.editProviderPolicy",reason:"Correct the reviewed provider name",providerContextRevision:providerContext.providerContextRevision,previewDigest:"b".repeat(64),expiresAt:"2099-01-01T00:00:00Z",
  changes:[{field:"providerFullName",before:"Original provider",after:"Updated provider"}],signatureTimestampAction:"retain",impact:providerContext.impact};
export const providerResult:ProviderResult={commandId:providerCommand,courseId:providerCourse,action:"learning.editProviderPolicy",providerId:providerContext.profile!.id,providerContextRevision:"c".repeat(64),appliedAt:"2026-09-11T12:00:00Z",replayed:false};
