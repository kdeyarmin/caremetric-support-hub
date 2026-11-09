import { describe, expect, it } from 'vitest';
import { extractCarebase, extractIntel } from './refresh-product-features.mjs';

// The shape of Intel's pages, cut down to one of each part.
const featuresPage = (extra = '') => `<nav class="cm-features-jump"><p>2<!-- --> features in <!-- -->1<!-- --> areas</p></nav>
<p class="cm-features-legend">A feature with no label is on every plan.</p>
<section id="referrals" class="cm-features-area" aria-labelledby="r"><div><h2 id="r">Referral and admission tracking</h2><p>Your organization&#x27;s own results.</p></div>
<ul class="cm-features-list"><li><h3>EMR report imports</h3><p>Import referrals from CSV reports. Saved layouts cover HCHB, WellSky, Axxess and MatrixCare.</p><p class="cm-features-access">Owners</p></li>
<li><h3>Referral funnel</h3><p>Referrals received, admitted and not admitted.${extra}</p></li></ul></section>
<p>Feature availability, territory and usage limits vary by plan.</p>`;
const homePage = `<p class="cm-hero-description">A healthcare marketing CRM, market intelligence, territory analysis, and referral tracking in one workspace.</p>
<article class="cm-capability-card"><div><span class="cm-feature-number">01</span></div><h3>Understand the market</h3><p>Analyze your market first.</p><span class="cm-feature-tag">Marketing &amp; territory analysis</span></article>
<div class="cm-capability-grid cm-care-settings-grid"><article class="cm-capability-card"><h3>Hospitals</h3><p>Support your marketing plan.</p></article></div></div>
<button id="_R_1_-tab-0"><span>Providers</span></button>
<div id="_R_1_-panel-0" role="tabpanel" aria-labelledby="_R_1_-tab-0" class="cm-data-panel"><h3>Know who is practicing.</h3><ul><li>NPI identifiers</li></ul>
<div class="cm-data-source-line"><strong>Source</strong><p>NPPES</p></div><h4>Who should we research?</h4><p>Build a target list.</p><p class="cm-data-limit">A research signal, not a promise.</p></div>
<script type="application/ld+json">{"@graph":[{"@type":"FAQPage","mainEntity":[{"name":"Is CareMetric Intel a CRM?","acceptedAnswer":{"text":"Yes."}},{"name":"How do we purchase a subscription?","acceptedAnswer":{"text":"From Billing."}}]}]}</script>`;

describe('reading Intel\'s published features', () => {
  it('reads each area, feature, plan label, pillar, data family, care setting and answer from the pages', () => {
    const catalog = extractIntel(homePage, featuresPage());
    expect(catalog.publishedCount).toBe(2);
    expect(catalog.areas).toEqual([{ key: 'referrals', name: 'Referral and admission tracking', intro: 'Your organization\'s own results.', features: [
      { name: 'EMR report imports', does: 'Import referrals from CSV reports. Saved layouts cover common home health and hospice EMR reports.', access: 'Owners' },
      { name: 'Referral funnel', does: 'Referrals received, admitted and not admitted.', access: null },
    ] }]);
    expect(catalog.pillars).toEqual([{ title: 'Understand the market', why: 'Analyze your market first.', area: 'Marketing & territory analysis' }]);
    expect(catalog.data).toEqual([{ family: 'Providers', headline: 'Know who is practicing.', includes: ['NPI identifiers'], source: 'NPPES', question: 'Who should we research?', decision: 'Build a target list.', limit: 'A research signal, not a promise.' }]);
    expect(catalog.settings).toEqual([{ name: 'Hospitals', text: 'Support your marketing plan.' }]);
    // Purchasing belongs to the fact sheet, which reads Intel's own catalog.
    expect(catalog.faq).toEqual([{ question: 'Is CareMetric Intel a CRM?', answer: 'Yes.' }]);
    expect(catalog.caveats).toEqual(['Feature availability, territory and usage limits vary by plan.']);
    expect(JSON.stringify(catalog)).not.toMatch(/WellSky|MatrixCare|HCHB|Axxess/);
  });

  it('stops rather than let another product\'s name through', () => {
    expect(() => extractIntel(homePage, featuresPage(' Works alongside Trella.'))).toThrow(/Another product is named/);
  });
});

// CareBase's pages, cut down to one of each part, in the shape of their markup (attributes included, as the extractor strips them).
const carebaseFeatures = `<p class="x">The full capability index</p><h1>Everything</h1><p class="y">Explore tools for staff training.</p>
<span class="z">60+ capabilities</span>
<div class="a"><span class="b">2<!-- --> capabilities</span></div><h3 class="c">Training &amp; compliance core</h3><ul class="d"><li class="e"><span aria-hidden="true" class="f"></span><span>Today — daily priorities</span></li><li class="e"><span aria-hidden="true" class="f"></span><span>Compliance tracking &amp; automatic alerts</span></li></ul>
<span class="n">New</span><span class="m">Survey Day Mode</span></div><h3 class="h">A single workspace</h3><p class="p">Open Survey Day Mode.</p>
<ol><li><div><span>01</span><div><h3>Inquiry &amp; admission</h3><p>Track inquiries.</p></div></div></li></ol>
<p>Choose the modules you need.</p><p class="l">Your subscription determines which modules you can use.</p>
<ul><li><div><span aria-hidden="true">01</span><h3>Facility manager</h3></div><p><span>Sees</span>assigned sites only.</p><p><span>Does</span>resolves gaps.</p></li></ul>`;
const carebaseHome = `<h1>Compliance on track.</h1><div><p class="hero">Manage staff training in one place.</p></div>
<p>In plain English</p><h2>One system</h2></div><p>CareBase brings records together.</p>
<div><div><span>01</span><span>Survey readiness</span></div><h3>Prepare for your next survey</h3><p>Keep supporting records together.</p></div>
<p>What sets it apart</p><div><h3>A readiness score organized by regulatory topic</h3><p>It is not a prediction of survey results.</p><p>See which tracked requirements need attention</p></div><p>A free resource</p>
<ul><li><span><span>Before: </span>Sign-in sheets added up once a year</span><svg viewBox="0 0 1 1"><path d="M0"/></svg><span><span>With CareBase: </span>Hours logged as the training happens</span></li></ul>
<div><span>55 Pa. Code Chapter 2600</span><h3>I run a personal care home</h3><p>12 hours of training a year.</p><p><strong>Records.</strong> Kept together.</p><ul aria-label="x"><li><span>12-hour annual training requirement</span></li></ul></div>`;
const carebaseFaq = `<script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"name":"What is CareMetric CareBase?","acceptedAnswer":{"text":"Software for staff training."}},
{"name":"How much does it cost?","acceptedAnswer":{"text":"$199."}},{"name":"Does it guarantee compliance or a deficiency-free survey?","acceptedAnswer":{"text":"No."}},
{"name":"Can a new organization start immediately?","acceptedAnswer":{"text":"You can begin signup online without a sales call. You can also explore demo options with fictional facility data before setting up your own organization."}}]}</script>`;

describe('reading CareBase\'s published capabilities', () => {
  it('reads each module, the newest tools, the lifecycle, the roles, why it matters, before and after, the chapters and the answers', () => {
    const catalog = extractCarebase({ home: carebaseHome, features: carebaseFeatures, faq: carebaseFaq });
    expect(catalog.publishedCount).toBe(60);
    expect(catalog.overview).toBe('Manage staff training in one place.');
    expect(catalog.summary).toBe('CareBase brings records together.');
    expect(catalog.modules).toEqual([{ name: 'Training & compliance core', capabilities: ['Today — daily priorities', 'Compliance tracking & automatic alerts'], count: 2 }]);
    expect(catalog.newest).toEqual([{ name: 'Survey Day Mode', headline: 'A single workspace', does: 'Open Survey Day Mode.' }]);
    expect(catalog.lifecycle).toEqual([{ step: 'Inquiry & admission', text: 'Track inquiries.' }]);
    expect(catalog.roles).toEqual([{ role: 'Facility manager', sees: 'assigned sites only.', does: 'resolves gaps.' }]);
    expect(catalog.pillars).toEqual([
      { title: 'Prepare for your next survey', why: 'Keep supporting records together.', area: 'Survey readiness' },
      { title: 'A readiness score organized by regulatory topic', why: 'It is not a prediction of survey results.', area: 'See which tracked requirements need attention' },
    ]);
    expect(catalog.beforeAfter).toEqual([{ before: 'Sign-in sheets added up once a year', after: 'Hours logged as the training happens' }]);
    expect(catalog.chapters).toEqual([{ chapter: '55 Pa. Code Chapter 2600', title: 'I run a personal care home', text: '12 hours of training a year. Records. Kept together.', highlights: ['12-hour annual training requirement'] }]);
    // Prices are the fact sheet's; demos and sales calls are never offered.
    expect(catalog.faq.map(item => item.question)).toEqual(['What is CareMetric CareBase?', 'Does it guarantee compliance or a deficiency-free survey?', 'Can a new organization start immediately?']);
    expect(catalog.faq.at(-1).answer).toBe('You can begin signup online on your own.');
    expect(catalog.caveats).toEqual(['It is not a prediction of survey results.', 'No.']);
  });
});
