import { z } from 'zod';
import { eventKinds } from './policy.mjs';
const uuid=z.uuid(),text=n=>z.string().max(n),instant=z.iso.datetime({offset:true});
export const activitySchema=z.object({tenantId:uuid,eventKey:text(200).min(1),kind:z.enum(eventKinds),occurredAt:instant,
 facts:z.object({source:z.enum(['direct','search','outbound','referral']).optional(),campaign:z.string().max(100).regex(/^[a-z0-9:._-]+$/).optional(),trialEnd:instant.optional(),count:z.number().int().min(0).max(1000000).optional(),metric:z.enum(['active_users','completed_training','provider_lists','outreach_replies']).optional()}).strict().default({}),
}).strict();
