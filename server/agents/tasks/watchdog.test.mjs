import { describe, expect, it } from 'vitest';
import { watchdogFindings } from './watchdog.mjs';
import { composeBrief } from './brief.mjs';

const now = new Date('2026-11-16T12:00:00Z');
const agent = over => ({ key: 'marketing_manager', name: 'Marketing Manager', status: 'active', scheduled: true, lastRunAt: '2026-11-16T09:00:00Z', failed7d: 0, oldestOverdueAt: null, ...over });
const toolkit = [{ key: 'growth_email', agents: ['marketing_manager'], configured: false, missing: ['Turn on Settings → Email → Growth email service.'] }];

describe('the watchdog', () => {
  it('names an active agent that has gone quiet, with the likely cause, and leaves a paused one alone', () => {
    const findings = watchdogFindings({ agents: [agent({ lastRunAt: '2026-11-11T09:00:00Z' }), agent({ key: 'seo_analyst', name: 'SEO Analyst', status: 'paused', lastRunAt: null }),
      agent({ key: 'social_manager', name: 'Social Media Manager', lastRunAt: null })] }, { now, toolkit, idleDays: 3 });
    expect(findings.map(item => item.key)).toEqual(['idle:marketing_manager', 'idle:social_manager']);
    expect(findings[0].text).toBe('Marketing Manager has not run for 5 days. Likely cause: Turn on Settings → Email → Growth email service.');
    expect(findings[1].text).toMatch(/^Social Media Manager has never run\./);
    expect(watchdogFindings({ agents: [agent({ lastRunAt: '2026-11-11T09:00:00Z' })] }, { now, idleDays: 7 })).toEqual([]);
  });

  it('names failing agents, stuck work, a stalled funnel stage and a step handed over on thin evidence', () => {
    const findings = watchdogFindings({
      agents: [agent({ failed7d: 4, oldestOverdueAt: '2026-11-16T09:00:00Z' })],
      funnel: { found: 12, qualified: 6, emailed: 0, replied: 0 },
      thinSteps: [{ category: 'cold_email', label: 'Cold email', reviewed: 2, rejected: 1 }],
    }, { now, toolkit });
    expect(findings.map(item => item.key)).toEqual(['failing:marketing_manager', 'stuck:marketing_manager', 'stalled:emailed', 'thin:cold_email']);
    expect(findings[2].text).toBe('This week: 6 prospects qualified, but no emails sent. Likely cause: Turn on Settings → Email → Growth email service.');
    expect(findings[3].text).toContain('Cold email runs on its own with 2 decisions of yours behind it (1 turned down)');
    expect(watchdogFindings(null)).toEqual([]);
  });

  it('adds its findings to the morning brief\'s list of what is worth knowing', () => {
    const brief = composeBrief({ approvals: { count: 0 }, yesterday: {}, agents: [] }, { now, watchdog: [{ key: 'idle:x', text: 'Marketing Manager has not run for 5 days.' }] });
    expect(brief.body).toContain('- Watchdog: Marketing Manager has not run for 5 days.');
  });
});
