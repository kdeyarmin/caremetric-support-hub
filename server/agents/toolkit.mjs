/** Configuration inventory for the owner, using the same clients and validators as the workers.
 * These checks make no provider requests, authorize no actions and never return credentials.
 * Agent status, schedules, product policies and approvals are separate execution controls.
 */
import { live } from '../live.mjs';
import { readCredentials, readProperties } from './seo/search-console.mjs';
import { lifecycleReadiness } from './accounts/lifecycle.mjs';
import { defaultMarketed } from './marketing.mjs';

const has = (features, key) => features?.has?.(key) === true;
const labels = { 'caremetric-intel': 'CareMetric Intel', carebase: 'CareBase', advisors: 'Healthcare Advisors' };
const source = { 'caremetric-intel': 'intel', carebase: 'carebase', advisors: 'advisors' };
const keyNames = { 'caremetric-intel': 'INTEL', carebase: 'CAREBASE', advisors: 'ADVISORS' };
const modelStep = 'Set ANTHROPIC_API_KEY on the Hub service.';
const schemaStep = name => `Release the ${name} database feature through the normal deployment process.`;

export function marketingToolkit({ features = null, growth = null, growthMail = null, model = null, customerTextToAi = false,
  communications = null, email = null, leadSecrets = {}, lifecycle = {}, social = null, socialWork = null, creativeWork = null,
  searchConsoleCredentials = '', searchConsoleSites = [], visitorMetrics = null, marketed = defaultMarketed } = {}) {
  const tools = [];
  const add = (key, label, agents, detail, checks, settingsPath = '/admin/settings') => {
    const missing = checks.filter(([ok]) => !ok).map(([, action]) => action);
    tools.push({ key, label, agents, configured: missing.length === 0, missing, detail, ...(settingsPath ? { settingsPath } : {}) });
  };
  const growthOn = has(features, 'platform.agents.customer-growth.v1');
  const growthState = growth?.readiness?.() ?? {};
  const ai = model?.configured === true && typeof model.run === 'function';
  const socialOn = has(features, 'platform.agents.social.v1');
  const socialSettings = live(social) ?? {};
  const meta = socialWork?.meta?.configured ?? {};
  const linkedin = socialWork?.linkedin?.configured ?? {};
  const socialFeature = [socialOn, schemaStep('Social Media Manager')];
  const growthFeature = [growthOn && Boolean(growth), schemaStep('customer growth')];

  add('prospect_research', 'Prospect discovery and research', ['marketing_manager'],
    'Finds organizations through Brave Search, records public sources and feeds the sales pipeline. Manual prospects and evidence remain available in Customer growth.', [
      growthFeature, [growth?.research?.configured === true, 'Set HUB_GROWTH_SEARCH_API_KEY on the Hub service.'],
      [ai, modelStep],
    ], '/admin/growth');
  add('growth_email', 'Prospect email and follow-ups', ['marketing_manager'],
    'Drafts outreach and sends eligible, reviewed messages. Campaign policy, contact eligibility, frequency limits and approvals still apply.', [
      growthFeature, [growthState.sending === true, 'Turn on Settings → Customer growth → Send growth email when ready to send.'],
      [growthMail?.configured === true && typeof growthMail.send === 'function', 'Configure the SendGrid key and Settings → Email → Growth email sender (or support sender) and Reply-To.'],
      [growthState.signing === true, 'Set HUB_GROWTH_SIGNING_KEY to a stable secret of at least 32 characters.'],
      [growthState.postalAddress === true, 'Set Settings → Email → Mailing address in email footers.'],
      [growthState.publicOrigin === true, 'Configure an HTTPS public origin for unsubscribe links.'],
    ]);
  add('delivery_feedback', 'Email delivery and suppression feedback', ['marketing_manager', 'account_manager'],
    'Receives signed SendGrid delivery, bounce, complaint and unsubscribe events. Confirm the event webhook in SendGrid; a configured key alone does not prove events are arriving.', [
      growthFeature, [growthState.deliveryFeedback === true, 'Set a valid HUB_SENDGRID_EVENT_PUBLIC_KEY and connect SendGrid’s signed event webhook.'],
    ], '/admin');
  add('sales_answers', 'Prospect questions and sales answers', ['sales_executive'],
    'Answers eligible prospect questions using product facts, the sales playbook and published guides, with a self-service next step.', [
      [has(features, 'platform.agents.sales-executive.v1'), schemaStep('Sales Executive')],
      [ai, modelStep], [live(customerTextToAi) === true, 'Turn on Settings → AI team → Let agents send customer messages to the AI.'],
      [typeof communications?.reply === 'function', 'Connect the Communications reply service.'],
      [email?.configured === true, 'Configure SendGrid and Settings → Email → Support sender and Reply-To to deliver sales answers by email.'],
    ]);
  add('content_publication', 'Search content and article publishing', ['content_marketer'],
    'Creates product articles from supported facts and topics, checks claims and publishes approved articles. Verify the resulting public page and the product website’s article feed after publication.', [
      [has(features, 'platform.agents.content.v1'), schemaStep('Content Marketer')],
      [has(features, 'content.public-articles.v1'), schemaStep('public articles')], [ai, modelStep],
    ], '/admin');
  const customer = lifecycleReadiness(lifecycle);
  const customerSteps = { mail: 'Configure SendGrid and the support email sender and Reply-To in Settings → Email.', postal_address: 'Set Settings → Email → Mailing address in email footers.', public_origin: 'Configure an HTTPS public origin for customer unsubscribe links.' };
  add('customer_email', 'Trial activation and customer follow-up', ['account_manager'],
    'Prepares onboarding, setup nudges and trial check-ins from customer records. Product activity must be reported to time the right message.', [
      [has(features, 'platform.agents.lifecycle.v1'), schemaStep('customer lifecycle')],
      ...customer.missing.map(key => [false, customerSteps[key]]),
    ]);
  for (const product of marketed ?? defaultMarketed) {
    if (!labels[product]) continue;
    add(`website_leads_${source[product]}`, `${labels[product]} website leads`, ['growth_manager', 'sales_executive'],
      'Receives signed website leads. The product must forward its forms with the matching secret; verify a lead appears in Leads.', [
        [has(features, 'support.leads.v1'), schemaStep('website leads')],
        [typeof leadSecrets[source[product]] === 'string' && leadSecrets[source[product]].length >= 32,
          `Set HUB_LEAD_SECRET_${keyNames[product]} on the Hub and the matching signing secret on the product.`],
      ], '/admin');
    if (product === 'advisors') continue;
    add(`product_events_${source[product]}`, `${labels[product]} trial and purchase tracking`, ['marketing_manager', 'sales_executive', 'account_manager'],
      product === 'caremetric-intel' && growthState.appEvents === true
        ? 'Accepts activity through Intel’s existing authenticated billing connection. Verify real trial, first-value and paid events in Customer growth; an available endpoint does not confirm the native producer is delivering.'
        : 'Receives signed trial, activation and payment events for conversion and retention measurement. Verify real events in Customer growth; signing setup does not confirm native-app delivery.', [
        growthFeature, [growthState.events?.[product] === true || (product === 'caremetric-intel' && growthState.appEvents === true), product === 'caremetric-intel'
          ? 'Release Intel’s authenticated activity endpoint and connect its existing billing client, or configure HUB_GROWTH_INTEL_EVENT_KEY for the legacy signed feed.'
          : `Set HUB_GROWTH_${keyNames[product]}_EVENT_KEY and connect signed activity events from the product.`],
      ], '/admin/growth');
  }
  for (const [key, label, configured, setup] of [
    ['facebook', 'Facebook publishing and inbox', meta.pages, 'Set HUB_META_ACCESS_TOKEN and Settings → Social media → Facebook Page id.'],
    ['instagram', 'Instagram publishing and comments', meta.instagram, 'Set HUB_META_ACCESS_TOKEN, Facebook Page id and Instagram account id in Settings → Social media.'],
    ['linkedin', 'LinkedIn publishing and comments', linkedin.page, 'Connect a LinkedIn Page token (or full refresh credentials) and Settings → Social media → LinkedIn Company Page id.'],
  ]) add(key, label, ['social_manager'], key === 'linkedin'
    ? 'Publishes posts and handles comments after LinkedIn grants API access. Private Page messages remain with the owner.'
    : 'Publishes planned posts and handles eligible interactions after provider permissions are granted.', [socialFeature, [configured === true, setup], [ai, modelStep]]);
  add('social_images', 'Fallback images for social publishing', ['social_manager', 'creative_director'],
    'Optional when approved images are available on Creative. Instagram requires either an approved Creative image or a fallback image to publish.', [
      socialFeature, [(socialSettings.imageUrls?.length ?? 0) > 0, 'Add fallback images in Settings → Social media → Approved brand images if you are not supplying approved images through Creative.'],
    ], '/admin/creative');
  add('social_video', 'Approved video publishing', ['social_manager', 'creative_director'],
    'Publishes approved Creative videos to connected Facebook and LinkedIn Pages, or vertical Instagram Reels. Upload and processing progress is saved across worker restarts. Provider permissions and action approvals still apply; paid video ads and YouTube are handled manually.', [
      socialFeature, [has(features, 'platform.agents.social-video.v1'), schemaStep('video publishing')],
      [has(features, 'platform.agents.creative.v1'), schemaStep('Creative Director')],
      [meta.pages === true || meta.instagram === true || linkedin.page === true, 'Connect at least one Facebook, Instagram or LinkedIn Page and its publishing credentials in Settings → Social media.'],
    ], '/admin/creative');
  add('ad_optimization', 'Ad results and creative testing', ['social_manager', 'creative_director'],
    'Reviews existing Meta ad sets and LinkedIn campaigns, pauses losers and can reuse approved creative within their budgets. Fresh ad copy needs the AI model. Set Target cost per lead or sign-up in Settings → Social media for cost-based evaluation; without it, ads are compared with each other. Initial campaigns, audiences and conversion tracking are set up in the ad platform.', [
      socialFeature, [meta.ads === true || linkedin.ads === true, 'Connect a Meta or LinkedIn ad account and its API credentials.'],
    ]);
  add('ad_budget_increases', 'Ad budget recommendations', ['social_manager'],
    'May propose increases for efficient existing campaigns. Every increase still needs owner approval.', [
      socialFeature, [meta.ads === true || linkedin.ads === true, 'Connect a Meta or LinkedIn ad account and its API credentials.'],
      [socialSettings.settings?.maxDailyBudgetCents > 0, 'Set Settings → Social media → Most any ad may spend per day.'],
      [socialSettings.settings?.targetCostCents > 0, 'Set Settings → Social media → Target cost per lead or sign-up.'],
    ]);
  const credentials = readCredentials(searchConsoleCredentials);
  const properties = readProperties(live(searchConsoleSites));
  add('search_performance', 'Search performance and SEO opportunities', ['seo_analyst', 'chief_of_staff'],
    'Adds search queries, impressions, clicks and rankings to the site audit. Google must grant the service account access to each property; the crawl works without this connection. For model-written title and description suggestions, use Run now on Weekly SEO check or enable the individual weekly reports.', [
      [credentials.state === 'ready', 'Set a valid Google service-account JSON key in HUB_SEARCH_CONSOLE_CREDENTIALS.'],
      [properties.properties.length > 0 && properties.invalid === 0, 'List valid Search Console properties in Settings → Search and grant the service account access in Google.'],
    ]);
  const creative = creativeWork?.config?.() ?? {};
  add('creative_production', 'Ad image and video production', ['creative_director'],
    `Produces branded assets for review. Videos use ${creative.videoProvider === 'heygen' ? 'HeyGen where a brand kit has an avatar and voice, otherwise the Hub renderer' : 'the Hub renderer'}. Approved images can feed social posts and ads; approved videos can feed connected social channels once video publishing is configured.`, [
      [creativeWork?.declared === true, schemaStep('Creative Director')],
      [creativeWork?.enabled?.() === true, 'Turn on Settings → Creative → Turn on the Creative Director.'],
      [creative.dailyRenderCap > 0, 'Set Settings → Creative → Most renders a day above zero.'], [ai, modelStep],
    ], '/admin/creative');
  const visitors = visitorMetrics?.readiness?.() ?? {};
  add('visitor_conversion_analytics', 'Intel website session measurement', ['marketing_manager', 'chief_of_staff'],
    'Reads aggregate anonymous public-site browser-tab sessions from Intel for the Monday scorecard. A tab keeps its session across reloads; these are not unique people or standard 30-minute analytics sessions. Collection begins after native setup; weeks without full coverage remain unavailable. CareBase measurement and matched visitor-to-trial attribution are not included.', [
      [visitors.declared === true, schemaStep('website session measurement')],
      [visitors.enabled === true, 'Turn on Settings → Website analytics → Read Intel website sessions.'],
      [visitors.signing === true, 'Set the same HUB_VISITOR_METRICS_KEY (at least 32 characters) on the Hub and Intel services, and release Intel’s measurement endpoint.'],
    ]);
  return tools;
}
