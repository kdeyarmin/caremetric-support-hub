import { z } from 'zod';
import { eventKinds } from './policy.mjs';
const uuid=z.uuid(),text=n=>z.string().max(n),instant=z.iso.datetime({offset:true});
export const activitySchema=z.object({tenantId:uuid,eventKey:text(200).min(1),kind:z.enum(eventKinds),occurredAt:instant,
 facts:z.object({source:z.enum(['direct','search','outbound','referral']).optional(),campaign:z.string().max(100).regex(/^[a-z0-9:._-]+$/).optional(),trialEnd:instant.optional(),count:z.number().int().min(0).max(1000000).optional(),metric:z.enum(['active_users','completed_training','provider_lists','outreach_replies']).optional()}).strict().default({}),
}).strict();
/** Intel's trial milestones, sent as `active` events with this metric (team review 2026-11-17, stage 4). */
export const appMilestones=Object.freeze(['county_chosen','agency_saved','activated']);
// Native applications report activity only. Trials and payments come from the Hub's billing mirror.
export const appActivitySchema=z.object({account:z.string().regex(/^[0-9a-f]{24}$/),eventKey:uuid,
 kind:z.enum(['heartbeat','active','first_value']),occurredAt:instant,
 facts:z.object({count:z.number().int().min(0).max(1000000).optional(),metric:z.enum(['provider_lists',...appMilestones]).optional()}).strict().default({}),
}).strict().refine(value=>value.kind!=='first_value'||(value.facts.metric==='provider_lists'&&value.facts.count>0))
 // A milestone (20261117230000_trial_path.sql) is an `active` event; the database accepts them once it declares platform.agents.trial-path.v1.
 .refine(value=>!appMilestones.includes(value.facts.metric)||value.kind==='active');
