import { products, planOpportunity, qualify } from './policy.mjs';
import { draftMessage, growthPromptVersion } from './draft.mjs';
import { discoveryQuery, operatorHost } from './playbook.mjs';
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
    // A check-in is planned only when the database finds one due (private.growth_checkin_due), once per reason, never as outreach.
    const checkins = over => planOpportunity({ ...base, ...over }, now).filter(w => w.kind === 'checkin');
    check('not now is asked again once', checkins({ stage: 'nurture', touches: 1, checkin_due: 'not_now', last_reply_at: ago(100) }).length === 1);
    check('no check-in unless due', checkins({ stage: 'nurture', touches: 1, checkin_due: null }).length === 0 && checkins({ touches: 3, checkin_due: null }).length === 0);
    check('a check-in is not another touch', !planOpportunity({ ...base, touches: 3, checkin_due: 'no_reply' }, now).some(w => w.kind === 'outreach'));
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
    // A number the organization's own sources state may be repeated about it; one they do not state is refused, and a sentence about
    // the product states only the fact sheet's numbers (review 2026-11-12).
    const counted = { ...base, evidence: [{ ...evidence[0], claim: 'The organization serves 12 counties from two locations.' }] };
    const invokeFor = (opportunity, output) => draftMessage({ opportunity, work, task: {}, model: model(output) });
    check('number from the organization\'s sources allowed', (await invokeFor(counted, { ...draft, body: 'Your team covers 12 counties from two locations. Would a free trial help?' }))?.modelGenerated === true);
    check('number the sources do not state rejected', await invokeFor(counted, { ...draft, body: 'Your team covers 14 counties. Would a free trial help?' }) === null);
    check('organization number about the product rejected', await invokeFor(counted, { ...draft, body: `${product === 'carebase' ? 'CareBase' : 'CareMetric Intel'} covers all 12 counties. Would a free trial help?` }) === null);
    check('product page link allowed', (await invoke({ ...draft, body: `Would a free trial help?\n\n${product === 'carebase' ? 'https://cmcarebase.com/signup' : 'https://www.caremetricintel.com/'}` }))?.modelGenerated === true);
    check('other product page link rejected', await invoke({ ...draft, body: `Would a free trial help?\n\n${product === 'carebase' ? 'https://www.caremetricintel.com/' : 'https://cmcarebase.com/signup'}` }) === null);
    const page = product === 'carebase' ? 'https://cmcarebase.com/signup' : 'https://www.caremetricintel.com/';
    const ownTags = `utm_source=caremetric&utm_medium=email&utm_campaign=growth-${product === 'carebase' ? 'carebase' : 'intel'}-touch1`;
    const tagged = await invoke({ ...draft, body: `Would a free trial help?\n\n${page.replace(/(#.*)?$/, '?utm_source=x&utm_medium=y&utm_campaign=z$1')}` });
    check('tagged product page link allowed and given its campaign tags', tagged?.modelGenerated === true && tagged.body.endsWith(`${page}?${ownTags}`));
    check('tagged link to another host rejected', await invoke({ ...draft, body: 'Would a free trial help?\n\nhttps://unsupported.example.org/?utm_source=x&utm_medium=y&utm_campaign=z' }) === null);
    check('tag carrying another address rejected', await invoke({ ...draft, body: `Would a free trial help?\n\n${page}?utm_source=x&utm_medium=y&utm_campaign=z&next=https://unsupported.example.org` }) === null);
    check('discovery rotates daily', discoveryQuery(product, now) !== discoveryQuery(product, new Date(now.getTime() + 86400000)));
    check('directories are not prospects', !operatorHost('www.aplaceformom.com') && !operatorHost('pa.gov'));
    const fit = await assessProspect(base, {}, model({ fit: 70, rationale: 'Observed services fit the audience; buyer unknown.', citations: ['source-a'], nextAction: 'Verify the buyer.' }));
    check('intent stays unknown without customer action', fit?.intent === null);
    reports.push({ product, version: growthEvaluationVersion, prompt: growthPromptVersion, passed: results.every(r => r.passed), results, scope: 'synthetic behavioral guardrails; live model quality and conversion require reviewed pilot results' });
  }
  return reports;
}
