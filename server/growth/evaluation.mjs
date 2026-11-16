import { products, planOpportunity, qualify } from './policy.mjs';
import { draftMessage, growthPromptVersion, messageArms } from './draft.mjs';
import { discoveryQuery, operatorHost, playbookFor, shortFollowupClose, shortReportTouchAngle } from './playbook.mjs';
import { assessProspect } from './assessment.mjs';

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
    const invoke = output => draftMessage({ opportunity: base, work, task: {}, model: model(output) });
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
    const ownTags = `utm_source=caremetric&utm_medium=email&utm_campaign=growth-${product === 'carebase' ? 'carebase' : 'intel'}-touch1`;
    const tagged = await invoke({ ...draft, body: `Would a free trial help?\n\n${page.replace(/(#.*)?$/, '?utm_source=x&utm_medium=y&utm_campaign=z$1')}` });
    // utm_content names the draft's experiment arm (draft.mjs messageArms): short codes only.
    check('tagged product page link allowed and given its campaign tags', tagged?.modelGenerated === true && new RegExp(`${page.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?${ownTags}&utm_content=[a-z0-9-]{1,60}$`).test(tagged.body));
    check('tagged link to another host rejected', await invoke({ ...draft, body: 'Would a free trial help?\n\nhttps://unsupported.example.org/?utm_source=x&utm_medium=y&utm_campaign=z' }) === null);
    check('tag carrying another address rejected', await invoke({ ...draft, body: `Would a free trial help?\n\n${page}?utm_source=x&utm_medium=y&utm_campaign=z&next=https://unsupported.example.org` }) === null);
    // The short first email's test (2026-11-17, Settings → Customer growth → Test a short first email): only an Intel first email that
    // links the agency's own report, held by code to the report and one question, with the trial moved to the second email.
    const report = { label: 'Free market report for the agency', url: 'https://www.caremetricintel.com/report/synthetic.case' };
    const shortCase = Array.from({ length: 64 }, (_, i) => ({ ...base, id: `synthetic-${i}`, organization_id: `synthetic-org-${i}` }))
      .find(o => messageArms(o, o.evidence, { reportLed: true, shortTest: true }).form === 'short');
    const shortBody = `I run a home health and hospice agency, and I built CareMetric Intel to see my own market.\n\nI put together a free market report for your agency from public Medicare data. It shows where you stand in your county and who refers the most.\n${report.url}\n\nAre you getting your share of the referrals in your county?`;
    const seen = [];
    const capture = output => ({ configured: true, run: async (_task, request) => { seen.push(JSON.parse(request.user)); return { outcome: 'completed', output }; } });
    const shortDraft = { subject: 'Referrals in your county', body: shortBody, citations: ['source-a'], needsHuman: false };
    if (product === 'caremetric-intel') {
      const short = await draftMessage({ opportunity: shortCase, work, task: {}, model: capture(shortDraft), report, short: true });
      check('short first email links the report and asks one question', short?.arms?.form === 'short' && seen.at(-1)?.touchPlan === shortReportTouchAngle);
      check('short first email offering the trial rejected', await draftMessage({ opportunity: shortCase, work, task: {}, model: capture({ ...shortDraft, body: `${shortBody}\n\n${playbookFor(product).nextStep.url}` }), report, short: true }) === null);
      check('short first email over its length rejected', await draftMessage({ opportunity: shortCase, work, task: {}, model: capture({ ...shortDraft, body: `${shortBody}${' The report also lists the county\'s largest agencies and the hospitals its residents use.'.repeat(4)}` }), report, short: true }) === null);
      await draftMessage({ opportunity: { ...shortCase, touches: 1, first_form: 'short' }, work, task: {}, model: capture({ ...shortDraft, body: `Would the free trial help your team?\n\n${playbookFor(product).nextStep.url}` }), report, short: true });
      check('second email after a short first offers the trial with its card terms', seen.at(-1)?.touchPlan?.includes(shortFollowupClose) === true);
    } else {
      check('short first email never written for this product', (await draftMessage({ opportunity: shortCase, work, task: {}, model: capture(draft), report, short: true }))?.arms?.form === undefined);
    }
    check('discovery rotates daily', discoveryQuery(product, now) !== discoveryQuery(product, new Date(now.getTime() + 86400000)));
    check('directories are not prospects', !operatorHost('www.aplaceformom.com') && !operatorHost('pa.gov'));
    const fit = await assessProspect(base, {}, model({ fit: 70, rationale: 'Observed services fit the audience; buyer unknown.', citations: ['source-a'], nextAction: 'Verify the buyer.' }));
    check('intent stays unknown without customer action', fit?.intent === null);
    reports.push({ product, version: growthEvaluationVersion, prompt: growthPromptVersion, passed: results.every(r => r.passed), results, scope: 'synthetic behavioral guardrails; live model quality and conversion require reviewed pilot results' });
  }
  return reports;
}
