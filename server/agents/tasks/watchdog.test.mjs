import { describe, expect, it } from 'vitest';
import { lossFindings, watchdogFindings } from './watchdog.mjs';
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

  // Review 2026-11-17: the week every county snapshot was blocked, November's flight failed on LinkedIn and four of 32 cold emails
  // bounced, the watchdog said nothing.
  it('names what the team lost this week, as production showed it on November 16', () => {
    const losses = {
      creativeMade: 61, creativeBlocked: { fact_sheet: 12, vision_defect: 18, data_number: 8, unknown: 1 },
      launchFailed: { platform: 'linkedin', code: 'linkedin_permission', at: '2026-11-16T14:21:00Z' },
      held: { address_unchecked: 11, rejected: 3 },
      bounce: { guard: { on: true, tripped: false }, sent30: 32, bounced30: 4 },
      cap: { cap: 10, yesterday: 10, waiting: 6 },
      reach: { strongFits: 135, withoutAddress: 90 },
      ads: { budgetCents: 5000, launched: 0, live: 0, approved: 43 },
    };
    const found = lossFindings(losses);
    expect(found.map(item => item.key)).toEqual(['lost:creative', 'lost:launch:linkedin', 'lost:held', 'lost:bounce', 'lost:cap', 'lost:reach', 'lost:ads']);
    const text = Object.fromEntries(found.map(item => [item.key, item.text]));
    expect(text['lost:creative']).toBe('39 of the 61 images made this week were blocked by the team\'s own checks, most for the image review saw a problem (18).');
    expect(text['lost:launch:linkedin']).toBe('LinkedIn refused a new ad campaign (linkedin permission) on 2026-11-16, and none has been created since. Reconnect LinkedIn under Settings → Social media.');
    expect(text['lost:held']).toBe('14 qualified prospects waited more than a day with nothing drafted: 11 waiting for an address check, 3 behind a draft you turned down.');
    expect(text['lost:bounce']).toBe('4 of 32 cold emails in the last 30 days bounced (13%); keep it under 2% before raising "Most cold emails a day".');
    expect(text['lost:cap']).toContain('reached its cap of 10 yesterday with 6 approved emails waiting');
    expect(text['lost:reach']).toBe('90 of the 135 strong-fit prospects have no address the team may write to.');
    expect(text['lost:ads']).toBe('An ad budget of $50 a month is set, but no campaign was created this month and no creative is live (43 approved images waiting).');
    // The launch and the bounce guard come before quiet agents' lesser findings; a step on thin evidence comes last.
    const all = watchdogFindings({ agents: [agent()], losses, thinSteps: [{ category: 'cold_email', label: 'Cold email', reviewed: 2, rejected: 1 }] }, { now });
    expect(all[0].key).toBe('lost:launch:linkedin');
    expect(all).toHaveLength(8);
  });

  it('stays quiet when little was lost, and says the guard is off or tripped', () => {
    expect(lossFindings({ creativeMade: 10, creativeBlocked: { vision_defect: 2 }, held: { address_unchecked: 2 }, bounce: { sent30: 32, bounced30: 1 },
      cap: { cap: 10, yesterday: 9, waiting: 6 }, reach: { strongFits: 40, withoutAddress: 12 }, ads: { budgetCents: 5000, launched: 1, live: 0 } })).toEqual([]);
    expect(lossFindings({ bounce: { guard: { on: false }, sent30: 20, bounced30: 3 } })[0].text).toContain('The bounce guard is off');
    expect(lossFindings({ bounce: { guard: { on: true, tripped: true }, sent30: 20, bounced30: 3 } })[0]).toMatchObject({ key: 'lost:bounce', rank: 2 });
    expect(lossFindings({ launchFailed: { platform: 'meta', code: 'meta_invalid_request', at: '2026-11-16T14:21:00Z' } })[0].text).not.toContain('Reconnect');
    expect(lossFindings(null)).toEqual([]);
  });

  it('adds its findings to the morning brief\'s list of what is worth knowing', () => {
    const brief = composeBrief({ approvals: { count: 0 }, yesterday: {}, agents: [] }, { now, watchdog: [{ key: 'idle:x', text: 'Marketing Manager has not run for 5 days.' }] });
    expect(brief.body).toContain('- Watchdog: Marketing Manager has not run for 5 days.');
  });
});
