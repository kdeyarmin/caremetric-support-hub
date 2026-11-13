/**
 * The watchdog (20261113240000_agent_watchdog.sql): what the morning brief and the Monday scorecard say when part of the AI team has
 * gone quiet. It reads counts only (`private.agent_watchdog_facts`) and names, for each finding, the readiness step that is missing when
 * the toolkit knows one (toolkit.mjs `missing`):
 *
 * - an active agent with schedules that has not run for "Days before an idle agent is flagged" (Settings → AI team, default 3);
 * - an agent with three or more failed tasks in the last seven days, or a task waiting more than an hour past its time;
 * - a stage of the funnel that stopped while the one before it moved (prospects found but none emailed, emails out but no reply);
 * - an autonomy step that is automatic although the owner's decisions behind it fall short of today's evidence rule (flagged, never undone).
 */
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const day = 86_400_000;

// Which toolkit rows can explain an agent's silence.
const toolsFor = {
  marketing_manager: ['prospect_roster', 'prospect_research', 'growth_email', 'decision_makers', 'prospect_deep_research'],
  social_manager: ['social_images', 'paid_campaigns', 'founder_posts'],
  creative_director: ['creative_production', 'county_snapshots'],
};

function hintFor(agentKey, toolkit) {
  const rows = (Array.isArray(toolkit) ? toolkit : []).filter(row => (toolsFor[agentKey] ?? []).includes(row.key) || (row.agents ?? []).includes(agentKey));
  const first = rows.find(row => row.configured === false && Array.isArray(row.missing) && row.missing.length);
  return first ? ` Likely cause: ${first.missing[0]}` : '';
}

/**
 * @param {object} facts private.agent_watchdog_facts
 * @param {{ idleDays?: number, now?: Date, toolkit?: object[] }} options
 * @returns {{ key: string, text: string }[]} at most eight findings, the most pressing first
 */
export function watchdogFindings(facts, { idleDays = 3, now = new Date(), toolkit = [] } = {}) {
  if (!facts || typeof facts !== 'object') return [];
  const findings = [];
  for (const agent of Array.isArray(facts.agents) ? facts.agents : []) {
    if (agent.status !== 'active' || !agent.scheduled) continue;
    const last = Date.parse(agent.lastRunAt ?? '');
    const quiet = Number.isFinite(last) ? Math.floor((now.getTime() - last) / day) : null;
    if (quiet === null || quiet >= idleDays) {
      findings.push({ key: `idle:${agent.key}`, rank: 1, text: `${agent.name} has ${quiet === null ? 'never run' : `not run for ${plural(quiet, 'day')}`}.${hintFor(agent.key, toolkit)}` });
    }
    if (Number(agent.failed7d) >= 3) findings.push({ key: `failing:${agent.key}`, rank: 2, text: `${agent.name}: ${plural(Number(agent.failed7d), 'task')} failed in the last seven days.` });
    const waiting = Date.parse(agent.oldestOverdueAt ?? '');
    if (Number.isFinite(waiting) && now.getTime() - waiting > 3_600_000) {
      findings.push({ key: `stuck:${agent.key}`, rank: 2, text: `${agent.name} has work waiting since ${new Date(waiting).toISOString().slice(0, 16).replace('T', ' ')} UTC that has not started.` });
    }
  }
  const flow = facts.funnel ?? {};
  const stages = [['found', 'prospects found'], ['qualified', 'prospects qualified'], ['emailed', 'emails sent'], ['replied', 'replies']];
  for (let i = 1; i < stages.length; i += 1) {
    const [before, beforeLabel] = stages[i - 1], [stage, label] = stages[i];
    if (Number(flow[before]) >= 5 && Number(flow[stage]) === 0) {
      findings.push({ key: `stalled:${stage}`, rank: 3, text: `This week: ${flow[before]} ${beforeLabel}, but no ${label}.${stage === 'emailed' ? hintFor('marketing_manager', toolkit) : ''}` });
      break;
    }
  }
  for (const step of Array.isArray(facts.thinSteps) ? facts.thinSteps : []) {
    findings.push({ key: `thin:${step.category}`, rank: 4, text: `${step.label} runs on its own with ${plural(Number(step.reviewed), 'decision')} of yours behind it (${Number(step.rejected)} turned down). Watch it, or put it back under review on the AI team page.` });
  }
  return findings.sort((a, b) => a.rank - b.rank).slice(0, 8).map(({ key, text }) => ({ key, text }));
}
