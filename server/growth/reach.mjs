/**
 * Stage 3 of the AI workforce review of 2026-11-17 (docs/AI_WORKFORCE_REVIEW_2026-11-17.md): roster agencies ranked with more of what
 * Intel already sends (under pressure first), a web search for the agencies the name and phone searches missed (only a code-confirmed
 * site is used), and a live writing evaluation each Monday. Database: 20261117200000_growth_reach.sql and its gate
 * 20261117200100_growth_reach_contract.sql. A server deployed before the gate keeps the old behaviour.
 */
export const growthReachFeature='platform.agents.growth-reach.v1';
/** Whether the database declares stage 3's functions (a Set or an array of declared features). */
export const hasGrowthReach=features=>features instanceof Set?features.has(growthReachFeature):Array.isArray(features)&&features.includes(growthReachFeature);
/** The live writing evaluation's own version: recorded beside growth.1, never read by the send claim. */
export const liveEvaluationVersion='growth.live.1';
