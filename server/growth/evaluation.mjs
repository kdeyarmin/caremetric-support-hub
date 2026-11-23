import { products, planOpportunity, qualify } from './policy.mjs';
import { draftMessage, growthPromptVersion } from './draft.mjs';
import { discoveryQuery, operatorHost, playbookFor, reportTouchAngle, reviewTouchAngle, unviewedTouchAngle } from './playbook.mjs';
import { assessProspect } from './assessment.mjs';
import { readCampaign } from './campaign.mjs';

/**
 * The key the database's send claim requires for a recent passing evaluation (`version='growth.1'` in private.growth_claim_message).
 * It names this guardrail suite, not the drafting prompt: the suite may grow, and the prompt's own version is recorded on every run.
 */
export const growthEvaluationVersion = 'growth.1';

/** Golden behavioral cases. These evaluate the decision boundary, not live model persuasiveness. */
export async function evaluateGrowth(now = new Date()) {
  const at = now.toISOString(), ago = days => new Date(now - days * 86400000).toISOString();
  const reports = [];
  for (const product of products) {
    const results = [];
    const check = (name, passed) => results.push({ name, passed: Boolean(passed) });
    const evidence = [{ id: 'source-a', source_url: 'https://example.org/about', claim: 'The organization operates care services.', confidence: 'high', observed_at: at }];
    const base = { id: 'synthetic', version: 1, product, stage: 'qualified', contact_id: 'synthetic-contact', owner_agent: 'marketing_manager', next_at: ago(1), created_at: ago(10), evidence, policy: { max_touches: 3, approved_claim: 'See how the product workflow fits your team with a free trial.', booking_url: '' }, events: [] };
    check('initial outreach', planOpportunity(base, now).some(w => w.kind === 'outreach'));
    check('reply stops sequence', !planOpportunity({ ...base, events: [{ kind: 'reply', occurred_at: at }] }, now).some(w => w.kind === 'outreach'));
    check('touch cap', !planOpportunity({ ...base, touches: 3 }, now).some(w => w.kind === 'outreach'));
    check('internal excluded', planOpportunity({ ...base, internal: true }, now).length === 0);
    check('Breathe excluded', planOpportunity({ ...base, product: 'breathe' }, now).length === 0);
    check('stale sources rejected', !qualify([{ ...evidence[0], observed_at: ago(31) }], now).canDraft);
    const customer = { ...base, stage: 'paying', owner_agent: 'account_manager', activated_at: ago(8) };
    check('missing telemetry is unknown', planOpportunity(customer, now).some(w => w.kind === 'telemetry') && !planOpportunity(customer, now).some(w => w.kind === 'adoption'));
    check('fresh feed and stalled use triggers recovery', planOpportunity({ ...customer, events: [{ kind: 'heartbeat', occurred_at: at }, { kind: 'active', occurred_at: ago(8) }] }, now).some(w => w.kind === 'adoption'));
    check('cancellation routes to recovery', planOpportunity({ ...customer, events: [{ kind: 'cancel_requested', occurred_at: at }] }, now).some(w => w.kind === 'recovery'));
    const work = { kind: 'outreach', action: 'Offer one useful next step.', success: 'A qualified reply.' };
    const draft = { subject: 'A useful next step', body: 'Would a free trial with your own team be useful?', citations: ['source-a'], needsHuman: false };
    const model = output => ({ configured: true, run: async () => ({ outcome: 'completed', output }) });
    // Agency outreach has its own cases below. Use an Intel website-lead follow-up for the general link and claim cases.
    const general = product === 'caremetric-intel' ? { ...base, touches: 1, memory: { lead: { kind: 'county_report' } } } : base;
    const touch = product === 'caremetric-intel' ? 2 : 1;
    const invoke = output => draftMessage({ opportunity: general, work, task: {}, model: model(output) });
    check('cited output requires review', (await invoke(draft))?.modelGenerated === true);
    check('invented citation rejected', await invoke({ ...draft, citations: ['invented'] }) === null);
    check('unapproved link rejected', await invoke({ ...draft, body: 'Visit https://unsupported.example.org' }) === null);
    check('unsupported commitment abstains', await invoke({ ...draft, needsHuman: true }) === null);
    check('missing approved claim abstains', await draftMessage({ opportunity: { ...base, policy: {} }, work, task: {} }) === null);
    check('model draft with an unlisted price rejected', await invoke({ ...draft, body: 'Plans start at $27 a month. Would a free trial help?' }) === null);
    // No personal demos with anyone (owner decision 2026-11-09): an offer to talk, meet or demo is refused; declining one is not an offer.
    check('model draft offering a conversation rejected', await invoke({ ...draft, body: 'Would a short conversation about the workflow be useful?' }) === null);
    check('model draft offering a demo or call rejected', await invoke({ ...draft, body: 'Happy to set up a quick call or a live demo for your team.' }) === null);
    check('model draft asking for a time to meet rejected', await invoke({ ...draft, body: 'Pick a time that suits you to talk it through.' }) === null);
    check('declining a demo is not an offer', (await invoke({ ...draft, body: 'CareMetric does not do live demos. The free trial shows every step with your own team.' }))?.modelGenerated === true);
    check('model draft with a guarantee rejected', await invoke({ ...draft, body: 'We guarantee you will pass your next inspection.' }) === null);
    check('model draft naming a competitor rejected', await invoke({ ...draft, body: 'Unlike PointClickCare, we keep training in one place. Worth a look?' }) === null);
    check('product page link allowed', (await invoke({ ...draft, body: `Would a free trial help?\n\n${product === 'carebase' ? 'https://cmcarebase.com/signup' : 'https://www.caremetricintel.com/'}` }))?.modelGenerated === true);
    check('other product page link rejected', await invoke({ ...draft, body: `Would a free trial help?\n\n${product === 'carebase' ? 'https://www.caremetricintel.com/' : 'https://cmcarebase.com/signup'}` }) === null);
    const page = product === 'carebase' ? 'https://cmcarebase.com/signup' : 'https://www.caremetricintel.com/';
    const ownTags = `utm_source=caremetric&utm_medium=email&utm_campaign=growth-${product === 'carebase' ? 'carebase' : 'intel'}-touch${touch}`;
    const tagged = await invoke({ ...draft, body: `Would a free trial help?\n\n${page.replace(/(#.*)?$/, '?utm_source=x&utm_medium=y&utm_campaign=z$1')}` });
    // utm_content names the draft's experiment arm (draft.mjs messageArms): short codes only.
    check('tagged product page link allowed and given its campaign tags', tagged?.modelGenerated === true && new RegExp(`${page.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?${ownTags}&utm_content=[a-z0-9-]{1,60}$`, 'm').test(tagged.body));
    check('tagged link to another host rejected', await invoke({ ...draft, body: 'Would a free trial help?\n\nhttps://unsupported.example.org/?utm_source=x&utm_medium=y&utm_campaign=z' }) === null);
    check('tag carrying another address rejected', await invoke({ ...draft, body: `Would a free trial help?\n\n${page}?utm_source=x&utm_medium=y&utm_campaign=z&next=https://unsupported.example.org` }) === null);
    // The first email to a CareMetric Intel agency (owner direction 2026-11-17): the writer's opening, held by code to the report's one
    // link and at most one question, then what the software does and the trial, added by code. No prospect email brings up how the
    // trial bills, or says a card is required to start it (none is, since 2026-11-23).
    const report = { label: 'Free market report for the agency', url: 'https://www.caremetricintel.com/report/synthetic.case' };
    const reviewPage = 'https://www.caremetricintel.com/county-report';
    const inside = 'It shows where your agency stands among the agencies located in its county and which agencies lead the county. It also shows the hospitals the county\'s residents use most and the highest-ranked physicians for outreach.';
    const close = 'I run a home health and hospice agency, and I built CareMetric Intel to see my own market this way.\n\nDoes it match what your team sees in the field?';
    const firstBody = `I put together a free market report for your agency from Medicare data. It opens as a PDF, with nothing to sign up for:\n${report.url}\n\n${inside}\n\n${close}`;
    const seen = [];
    const capture = output => ({ configured: true, run: async (_task, request) => { seen.push(JSON.parse(request.user)); return { outcome: 'completed', output }; } });
    const firstDraft = { subject: 'Your county market report', body: firstBody, citations: ['source-a'], needsHuman: false };
    const first = (body, options = { report }) => draftMessage({ opportunity: base, work, task: {}, model: capture({ ...firstDraft, body }), ...options });
    if (product === 'caremetric-intel') {
      const written = await first(firstBody);
      check('first email to an agency is its market report and one question', written?.modelGenerated === true && written.arms?.form === 'short' && seen.at(-1)?.touchPlan === reportTouchAngle);
      check('first email offering the trial rejected', await first(`${firstBody}\n\nYou can also try it free for 30 days:\n${playbookFor(product).nextStep.url}`) === null);
      check('first email over its length rejected', await first(`${firstBody}${' The report also lists the county\'s largest agencies and the hospitals its residents use.'.repeat(6)}`) === null);
      check('first email with a second question rejected', await first(`${firstBody} Which county matters most to you?`) === null);
      check('first email without its report link rejected', await first(firstBody.replace(`\n${report.url}`, '')) === null);
      const review = await first(`A free report on your county, built from Medicare and Census data, is one step away. Choose your state and county and it is emailed to you as a PDF.\n${reviewPage}`, {});
      check('first email without a roster report points to the free county report page', review?.modelGenerated === true && review.arms?.form === 'short' && seen.at(-1)?.touchPlan === reviewTouchAngle);
      // Intel retired its market review on 2026-11-19: nobody is asked for an agency's certification number or name to get a report.
      check('first email asking for the agency\'s certification number rejected', await first(`A free report on your county is one step away. Enter your agency's CMS certification number and it is emailed to you as a PDF.\n${reviewPage}`, {}) === null);
      const second = body => draftMessage({ opportunity: { ...base, touches: 1 }, work, task: {}, model: capture({ ...firstDraft, subject: 'The hospitals your county uses', body }), report });
      const trial = `You can try it free for 30 days on one county:\n${playbookFor(product).nextStep.url}`;
      const followup = await second(`One part of the report shows hospitals your county's residents use. Does your team plan its week around them?`);
      check('second email offers the trial once', followup?.modelGenerated === true
        && seen.at(-1)?.touchPlan === unviewedTouchAngle && followup.body.includes('Start your 30-day free trial')
        && await second(`Does your team plan its week around these hospitals?\n\n${trial}`) === null);
      // Each of the agency's three emails carries its marketing sections after the writer's opening (campaign.mjs), and reads back whole.
      const whole = touches => draftMessage({ opportunity: { ...base, touches }, work, task: {}, report });
      const laid = async touches => readCampaign((await whole(touches))?.body, { reports: { accepts: url => url === report.url } });
      check('agency email says what the software does and offers the trial', (await laid(0))?.version === 2 && (await laid(1))?.touch === 2 && (await laid(2))?.touch === 3
        && written.body.includes('Know your market') && written.body.includes('Start your 30-day free trial'));
      check('prospect email calling the data public rejected', await second(`One page of the report, built from public Medicare data, lists the hospitals your county's residents use. Does your team plan its week around them?`) === null);
      check('prospect email naming the card rejected', await second(`Does your team plan its week around the hospitals your county's residents use?\n\nA credit card is required to start the subscription.`) === null);
    } else {
      check('report-led first email never written for this product', (await draftMessage({ opportunity: base, work, task: {}, model: capture(draft), report }))?.arms?.form === undefined);
    }
    check('discovery rotates daily', discoveryQuery(product, now) !== discoveryQuery(product, new Date(now.getTime() + 86400000)));
    check('directories are not prospects', !operatorHost('www.aplaceformom.com') && !operatorHost('pa.gov'));
    const fit = await assessProspect(base, {}, model({ fit: 70, rationale: 'Observed services fit the audience; buyer unknown.', citations: ['source-a'], nextAction: 'Verify the buyer.' }));
    check('intent stays unknown without customer action', fit?.intent === null);
    reports.push({ product, version: growthEvaluationVersion, prompt: growthPromptVersion, passed: results.every(r => r.passed), results, scope: 'synthetic behavioral guardrails; live model quality and conversion require reviewed pilot results' });
  }
  return reports;
}
