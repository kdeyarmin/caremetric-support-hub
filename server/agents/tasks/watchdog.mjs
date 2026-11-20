/**
 * The watchdog (20261113240000_agent_watchdog.sql): what the morning brief and the Monday scorecard say when part of the AI team has
 * gone quiet. It reads counts only (`private.agent_watchdog_facts`) and names, for each finding, the readiness step that is missing when
 * the toolkit knows one (toolkit.mjs `missing`):
 *
 * - an active agent with schedules that has not run for "Days before an idle agent is flagged" (Settings → AI team, default 3);
 * - an agent with three or more failed tasks in the last seven days, or a task waiting more than an hour past its time;
 * - a stage of the funnel that stopped while the one before it moved (prospects found but none emailed, emails out but no reply);
 * - an autonomy step that is automatic although the owner's decisions behind it fall short of today's evidence rule (flagged, never undone);
 * - what the team lost (20261117180000_work_recovery.sql, review 2026-11-17, when every county snapshot was blocked by the team's own
 *   check, the month's ad flight failed on LinkedIn and nothing said so): most of a week's images blocked, a campaign a platform refused
 *   with nothing created since, qualified prospects waiting more than a day with nothing drafted, cold email bouncing, the daily cap
 *   reached with a queue, most strong fits with no address, and an ad budget with nothing running.
 *
 * With the facts of 20261117240000_support_truth.sql (team review 2026-11-17, stage 5), an agent is idle by its own cadence: a finished
 * task counts as alive even when it skipped (a weekly report held for the scorecard, a writer's day off), a weekly schedule is idle only
 * after 8 days, and an agent whose every task in 14 days skipped is named with the reason (the Content Marketer out of topics). The
 * findings the owner can fix today (a platform that refused a campaign for its access, the bounce guard's pause) carry `needsYou`, so
 * the brief puts them under Needs you.
 */
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const day = 86_400_000;
const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const platformNames = { linkedin: 'LinkedIn', meta: 'Meta', google: 'Google Ads' };
// What a blocking rule means, for the owner.
const blockedBecause = {
  vision_defect: 'the image review saw a problem', fact_sheet: 'a number the fact sheet does not state', data_number: 'a number in the words around a county figure',
  data_figure: 'a figure that differs from its data', contrast: 'text too faint for its background', platform: 'a platform limit', brand_colors: 'a color outside the brand',
  unsubstantiated_claim: 'a claim the fact sheet does not support', plain_language: 'copy that is not plain', offer_mismatch: 'an offer billing does not have',
};
const heldBecause = { address_unchecked: 'waiting for an address check', rejected: 'behind a draft you turned down', bounce_guard: 'behind the bounce guard', other: 'for another reason' };
const counted = record => Object.entries(record ?? {}).map(([key, count]) => [key, num(count)]).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
const words = code => String(code ?? '').replaceAll('_', ' ');
// Why an agent's tasks skipped, for the owner.
const skipBecause = {
  no_topic: 'it has no topic left to write about (add topics, or it stays idle)', observe_only: 'it is on Observe, so it may not propose',
  no_marketed_product: 'no product is marketed (Settings → Marketing)',
};

/** The findings about what the team lost this week, from `facts.losses`. */
export function lossFindings(losses) {
  if (!losses || typeof losses !== 'object') return [];
  const findings = [];
  const blocked = counted(losses.creativeBlocked);
  const blockedTotal = blocked.reduce((sum, [, count]) => sum + count, 0);
  if (num(losses.creativeMade) >= 5 && blockedTotal * 2 >= num(losses.creativeMade)) {
    const [rule, count] = blocked[0];
    findings.push({ key: 'lost:creative', rank: 3,
      text: `${blockedTotal} of the ${num(losses.creativeMade)} images made this week were blocked by the team's own checks, most for ${blockedBecause[rule] ?? words(rule)} (${count}).` });
  }
  const failed = losses.launchFailed;
  if (failed && typeof failed === 'object' && failed.platform) {
    const name = platformNames[failed.platform] ?? failed.platform;
    const access = /_(?:token_invalid|permission|not_configured)$/.test(String(failed.code ?? ''));
    const where = failed.platform === 'google' ? 'Settings → Paid ads' : 'Settings → Social media';
    findings.push({ key: `lost:launch:${failed.platform}`, rank: 2, needsYou: access,
      text: `${name} refused a new ad campaign (${words(failed.code ?? 'error')}) on ${String(failed.at ?? '').slice(0, 10)}, and none has been created since.${access ? ` Reconnect ${name} under ${where}.` : ''}` });
  }
  const held = counted(losses.held);
  const heldTotal = held.reduce((sum, [, count]) => sum + count, 0);
  if (heldTotal >= 3) {
    findings.push({ key: 'lost:held', rank: 3,
      text: `${plural(heldTotal, 'qualified prospect')} waited more than a day with nothing drafted: ${held.map(([reason, count]) => `${count} ${heldBecause[reason] ?? words(reason)}`).join(', ')}.` });
  }
  const bounce = losses.bounce ?? {};
  const sent30 = num(bounce.sent30), bounced30 = num(bounce.bounced30);
  if (bounce.guard?.tripped === true) {
    findings.push({ key: 'lost:bounce', rank: 2, needsYou: true, text: 'Cold email is paused by the bounce guard. Resume it on Growth (Send guard) once the sender\'s domain records and the address checks are in order.' });
  } else if (sent30 >= 10 && bounced30 * 100 > 5 * sent30) {
    const off = bounce.guard?.on === true ? '' : ' The bounce guard is off (Settings → Customer growth → Pause cold email at this bounce rate).';
    findings.push({ key: 'lost:bounce', rank: 3,
      text: `${bounced30} of ${sent30} cold emails in the last 30 days bounced (${Math.round((100 * bounced30) / sent30)}%); keep it under 2% before raising "Most cold emails a day".${off}` });
  }
  const cap = losses.cap ?? {};
  if (num(cap.cap) > 0 && num(cap.yesterday) >= num(cap.cap) && num(cap.waiting) > 0) {
    findings.push({ key: 'lost:cap', rank: 4,
      text: `Cold email reached its cap of ${num(cap.cap)} yesterday with ${plural(num(cap.waiting), 'approved email')} waiting. Raise "Most cold emails a day" (Settings → Customer growth) only while bounces stay under 2%.` });
  }
  const reach = losses.reach ?? {};
  if (num(reach.withoutAddress) >= 10 && num(reach.withoutAddress) * 2 > num(reach.strongFits)) {
    findings.push({ key: 'lost:reach', rank: 4, text: `${num(reach.withoutAddress)} of the ${num(reach.strongFits)} strong-fit prospects have no address the team may write to.` });
  }
  const ads = losses.ads ?? {};
  if (num(ads.budgetCents) > 0 && num(ads.launched) === 0 && num(ads.live) === 0) {
    const waiting = num(ads.approved) ? ` (${plural(num(ads.approved), 'approved image')} waiting)` : '';
    findings.push({ key: 'lost:ads', rank: 4,
      text: `An ad budget of $${(num(ads.budgetCents) / 100).toFixed(0)} a month is set, but no campaign was created this month and no creative is live${waiting}.` });
  }
  return findings;
}

// Which toolkit rows can explain an agent's silence.
const toolsFor = {
  marketing_manager: ['prospect_roster', 'prospect_research', 'growth_email', 'decision_makers', 'prospect_deep_research'],
  social_manager: ['social_images', 'paid_campaigns', 'founder_posts'],
  creative_director: ['creative_production'],
};

function hintFor(agentKey, toolkit) {
  const rows = (Array.isArray(toolkit) ? toolkit : []).filter(row => (toolsFor[agentKey] ?? []).includes(row.key) || (row.agents ?? []).includes(agentKey));
  const first = rows.find(row => row.configured === false && Array.isArray(row.missing) && row.missing.length);
  return first ? ` Likely cause: ${first.missing[0]}` : '';
}

/**
 * @param {object} facts private.agent_watchdog_facts
 * @param {{ idleDays?: number, now?: Date, toolkit?: object[] }} options
 * @returns {{ key: string, text: string, needsYou?: true }[]} at most eight findings, the most pressing first
 */
export function watchdogFindings(facts, { idleDays = 3, now = new Date(), toolkit = [] } = {}) {
  if (!facts || typeof facts !== 'object') return [];
  const findings = [];
  for (const agent of Array.isArray(facts.agents) ? facts.agents : []) {
    if (agent.status !== 'active' || !agent.scheduled) continue;
    // The newer of the last run and the last finished task (a database without lastTaskAt reads runs only, as before).
    const times = [Date.parse(agent.lastRunAt ?? ''), Date.parse(agent.lastTaskAt ?? '')].filter(Number.isFinite);
    const last = times.length ? Math.max(...times) : NaN;
    const quiet = Number.isFinite(last) ? Math.floor((now.getTime() - last) / day) : null;
    const weekly = Number(agent.shortestSeconds) >= 7 * 86_400;
    if (quiet === null || quiet >= (weekly ? Math.max(idleDays, 8) : idleDays)) {
      findings.push({ key: `idle:${agent.key}`, rank: 1, text: `${agent.name} has ${quiet === null ? 'never run' : `not run for ${plural(quiet, 'day')}`}.${hintFor(agent.key, toolkit)}` });
    }
    if (Number(agent.failed7d) >= 3) findings.push({ key: `failing:${agent.key}`, rank: 2, text: `${agent.name}: ${plural(Number(agent.failed7d), 'task')} failed in the last seven days.` });
    // Every task of the last 14 days skipped: named with the commonest reason that is not the calendar (a day it does not work).
    if (num(agent.tasks14d) >= 5 && agent.worked14d !== undefined && num(agent.worked14d) === 0) {
      const reason = counted(agent.skipped14d).map(([code]) => code).find(code => !code.startsWith('not_'));
      if (reason) findings.push({ key: `skipping:${agent.key}`, rank: 2, text: `${agent.name} did nothing for 14 days: every task skipped, most often because ${skipBecause[reason] ?? words(reason)}.` });
    }
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
  findings.push(...lossFindings(facts.losses));
  for (const step of Array.isArray(facts.thinSteps) ? facts.thinSteps : []) {
    findings.push({ key: `thin:${step.category}`, rank: 5, text: `${step.label} runs on its own with ${plural(Number(step.reviewed), 'decision')} of yours behind it (${Number(step.rejected)} turned down). Watch it, or put it back under review on the AI team page.` });
  }
  return findings.sort((a, b) => a.rank - b.rank).slice(0, 8).map(({ key, text, needsYou }) => ({ key, text, ...(needsYou === true ? { needsYou: true } : {}) }));
}
