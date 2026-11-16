/**
 * Stage 2 of the AI workforce review of 2026-11-17 (docs/AI_WORKFORCE_REVIEW_2026-11-17.md): the day's ten cold emails go to the best
 * prospects first, inside the owner's send hours, and interest is acted on. Database: 20261117190000_growth_priority.sql and its gate
 * 20261117190100_growth_priority_contract.sql. A server deployed before the gate keeps the old behaviour.
 */
export const growthPriorityFeature='platform.agents.growth-priority.v1';
/** Whether the database declares stage 2's functions (a Set or an array of declared features). */
export const hasGrowthPriority=features=>features instanceof Set?features.has(growthPriorityFeature):Array.isArray(features)&&features.includes(growthPriorityFeature);
