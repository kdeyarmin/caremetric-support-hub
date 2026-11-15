/**
 * The owner's 2026-11-15 hand-over (supabase/migrations/20261115200000_autonomy_handover.sql): four autonomy steps that ship held and
 * that the owner switches to automatic on the AI team page. Named people's email addresses and the learning memo are decided in the
 * database (growth_person_address, growth_learning_propose). Ad campaign launch and founder posts are approved automatically by the
 * database only while their step is automatic, and the server checks the hand-over again before it launches or publishes anything.
 */
export const handoverFeature = 'platform.agents.autonomy-handover.v1';

export const handoverDeclared = features => (features instanceof Set ? features.has(handoverFeature) : Array.isArray(features) && features.includes(handoverFeature));

/**
 * Whether a task's agent, as it was when the task was claimed, may do `kind` on its own: on Act and trusted with it. Used only for wording
 * and planning; the database decides again when the action is proposed and when it is carried out.
 */
export const trustedWith = (agent, kind) => agent?.autonomy === 'act' && Array.isArray(agent?.config?.auto_approve_kinds) && agent.config.auto_approve_kinds.includes(kind);
