import { z } from 'zod';
import { appRequest } from '../lib/appSession';

const text = (max: number) => z.string().max(max).refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), 'Use plain text without control characters.');
const date = z.union([z.literal(''),z.iso.date()]);
export const phoneRecordSchema = z.object({
  number: text(16).regex(/^\+[1-9][0-9]{7,14}$/),
  label: text(100).trim().min(1), provider: text(100).trim().min(1), account: text(100),
  tenant: text(200).default(''), account_type: z.enum(['parent','subaccount','tenant_owned','shared','unknown']).default('unknown'),
  account_sid: z.union([z.literal(''),text(34).regex(/^AC[0-9a-fA-F]{32}$/)]).default(''),
  parent_account_sid: z.union([z.literal(''),text(34).regex(/^AC[0-9a-fA-F]{32}$/)]).default(''),
  business_profile_status: z.enum(['unknown','draft','pending','approved','rejected']).default('unknown'),
  messaging_registration: text(300).default(''), migration_status: z.enum(['unknown','planned','staged','active']).default('unknown'),
  purpose: text(500).trim().min(1), apps: text(300), owner: text(100),
  lifecycle: z.enum(['active','reserved','retired','unknown']),
  usage_status: z.enum(['observed','no_activity_observed','unknown']),
  voice_status: z.enum(['configured','not_configured','unknown']), voice_routing: text(500),
  sms_status: z.enum(['configured','pending','rejected','disabled','unknown']), sms_routing: text(500),
  last_used_on: date, reviewed_on: date, evidence: text(1000), notes: text(2000),
}).strict().refine(value => value.usage_status==='unknown' || (!!value.evidence.trim() && !!value.reviewed_on), {
  message: 'Record a review date and evidence when identifying usage.', path:['evidence'],
}).refine(value => [value.reviewed_on,value.last_used_on].every(day => !day || day<=new Date().toISOString().slice(0,10)), {
  message: 'Observation dates cannot be in the future.', path:['reviewed_on'],
});
export type PhoneRecord = z.infer<typeof phoneRecordSchema>;
export const phoneRowSchema = phoneRecordSchema.safeExtend({id:z.uuid(),version:z.number().int().positive(),updated_at:z.string()});
export type PhoneRow = z.infer<typeof phoneRowSchema>;
const listSchema = z.object({rows:z.array(phoneRowSchema),loaded_at:z.string()});
export const phoneRegistryClient = {
  async list(signal?: AbortSignal) {return listSchema.parse(await appRequest('rpc/list_phone_numbers',{},signal));},
  async save(record:PhoneRecord,previous:PhoneRow|null) {
    return phoneRowSchema.parse(await appRequest('rpc/save_phone_number',{p_id:previous?.id??null,p_record:phoneRecordSchema.parse(record),p_expected_version:previous?.version??0}));
  },
};
export type PhoneRegistryClient = typeof phoneRegistryClient;
export const blankPhoneRecord: PhoneRecord = {
  ...{"tenant":"","account_type":"unknown","account_sid":"","parent_account_sid":"","business_profile_status":"unknown","messaging_registration":"","migration_status":"unknown"},
  number:'',label:'',provider:'',account:'',purpose:'',apps:'',owner:'',lifecycle:'unknown',
  usage_status:'unknown',voice_status:'unknown',voice_routing:'',sms_status:'unknown',sms_routing:'',
  last_used_on:'',reviewed_on:'',evidence:'',notes:'',
};
export function displayPhone(number:string) {
  return /^\+1\d{10}$/.test(number) ? '('+number.slice(2,5)+') '+number.slice(5,8)+'-'+number.slice(8) : number;
}
export const phoneLabels = {
  account_type:{parent:'Parent account',subaccount:'Tenant subaccount',tenant_owned:'Tenant-owned account',shared:'Existing shared account',unknown:'Unknown'},
  business_profile_status:{unknown:'Unknown',draft:'Draft',pending:'Pending review',approved:'Approved',rejected:'Rejected'},
  migration_status:{unknown:'Not recorded',planned:'Migration planned',staged:'Prepared — not active',active:'Active'},
  lifecycle:{active:'Active',reserved:'Reserved',retired:'Retired',unknown:'Unknown'},
  usage_status:{observed:'Usage observed',no_activity_observed:'No activity observed',unknown:'Usage unknown'},
  voice_status:{configured:'Configured',not_configured:'Not configured',unknown:'Unknown'},
  sms_status:{configured:'Configured',pending:'Pending approval',rejected:'Rejected',disabled:'Disabled',unknown:'Unknown'},
};
