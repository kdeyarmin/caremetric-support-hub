import { z } from 'zod';
import { onboardingProducts, supportIdentity, supportIdentityOperation } from './onboardingProtocol.ts';

const uuid=z.uuid().transform(value=>value.toLowerCase());
const digest=z.string().regex(/^[0-9a-f]{64}$/);
const nativeId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const registrationProducts=onboardingProducts;
export const registrationProduct=z.enum(registrationProducts);
export const registrationIdentity=z.union([supportIdentity,z.object({product:z.literal('carebase'),sourceUserId:uuid,sourceAccountId:uuid,
  accountKind:z.literal('organization'),relationship:z.literal('organization_member'),revision:digest}).strict()]);
export function projectRegistrationIdentity(input:unknown,product:z.infer<typeof registrationProduct>,operation:z.infer<typeof supportIdentityOperation>){
  const envelope=z.object({contractVersion:z.literal(1),product:registrationProduct,operation:z.literal('support.identity.resolve'),generatedAt:z.iso.datetime({offset:true}),data:registrationIdentity}).strict().parse(input);
  if(envelope.product!==product||envelope.data.product!==product||envelope.data.sourceUserId!==operation.sourceUserId||envelope.data.sourceAccountId!==operation.sourceAccountId)throw new Error('Mismatched registration identity');
  return envelope.data;
}
export const invitationCode=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const registrationPhone=z.string().regex(/^\+[1-9][0-9]{7,14}$/);
export function normalizeRegistrationPhone(raw:string){const value=raw.replace(/[ ()-]/g,'');return /^\d{10}$/.test(value)?`+1${value}`:value;}
export const registrationPreview=z.object({reviewId:uuid,proofDigest:digest,expiresAt:z.iso.datetime({offset:true}),identity:registrationIdentity,
  phone:registrationPhone,displayName:z.string().min(1).max(120),tenantName:z.string().min(2).max(180)}).strict();
export type RegistrationPreview=z.infer<typeof registrationPreview>;
export const registrationInvitation=z.object({invitationId:uuid,identity:registrationIdentity,displayName:z.string().min(1).max(120),
  tenantName:z.string().min(2).max(180),phoneEnding:z.string().regex(/^[0-9]{4}$/),expiresAt:z.iso.datetime({offset:true}),
  state:z.enum(['pending','expired','revoked','claimed']),hubUserId:uuid.nullable()}).strict();
export type RegistrationInvitation=z.infer<typeof registrationInvitation>;
export const registrationList=z.object({rows:z.array(registrationInvitation).max(20),offset:z.number().int().min(0),total:z.number().int().min(0)}).strict();
export const registrationAdminRequest=z.discriminatedUnion('operation',[
  z.object({operation:z.literal('preview'),product:registrationProduct,sourceUserId:nativeId,sourceAccountId:nativeId,
    phone:registrationPhone,displayName:z.string().trim().min(1).max(120),tenantName:z.string().trim().min(2).max(180)}).strict(),
  z.object({operation:z.literal('issue'),reviewId:uuid,proofDigest:digest,requestId:uuid,claimCode:invitationCode,reviewed:z.literal(true)}).strict(),
  z.object({operation:z.literal('list'),offset:z.number().int().min(0).max(10000)}).strict(),
  z.object({operation:z.literal('revoke'),invitationId:uuid,reviewed:z.literal(true)}).strict(),
]);
export const registrationStart=z.object({claimCode:invitationCode,phone:registrationPhone,consent:z.literal(true)}).strict();
export const registrationVerify=z.object({challengeId:uuid,code:z.string().regex(/^[0-9]{6}$/)}).strict();
