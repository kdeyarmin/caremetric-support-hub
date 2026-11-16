import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractCarebase, extractIntel, products } from './refresh-product-features.mjs';

// The shape of Intel's pages, cut down to one of each part.
const featuresPage = (extra = '') => `<nav class="cm-features-jump"><p>2<!-- --> features in <!-- -->1<!-- --> areas</p></nav>
<p class="cm-features-legend">A feature with no label is on every plan.</p>
<section id="referrals" class="cm-features-area" aria-labelledby="r"><div><h2 id="r">Referral and admission tracking</h2><p>Your organization&#x27;s own results.</p></div>
<ul class="cm-features-list"><li><h3>EMR report imports</h3><p>Import referrals from CSV reports. Saved layouts cover HCHB, WellSky, Axxess and MatrixCare.</p><p class="cm-features-access">Owners</p></li>
<li><h3>Referral funnel</h3><p>Referrals received, admitted and not admitted.${extra}</p></li></ul></section>
<p>Feature availability, territory and usage limits vary by plan.</p>`;
const homePage = `<p class="cm-hero-description">A healthcare marketing CRM, market intelligence, territory analysis, and referral tracking in one workspace.</p>
<article class="cm-capability-card"><div><span class="cm-feature-number">01</span></div><h3>Understand the market</h3><p>Analyze your market first.</p><span class="cm-feature-tag">Marketing &amp; territory analysis</span></article>
<div class="cm-capability-grid cm-care-settings-grid">${['Home health agencies', 'Hospice agencies', 'Hospitals', 'Nursing homes', 'Personal care homes', 'Behavioral health']
  .map(name => `<article class="cm-capability-card"><h3>${name}</h3><p>Support your marketing plan.</p></article>`).join('')}</div><p class="cm-plan-note">Every plan welcomes healthcare organizations.</p></div></div>
<section id="for-managers" class="cm-section cm-managers" aria-labelledby="managers-title"><h2 id="managers-title">Know where the effort goes.</h2><p>Give the team a focused list.</p>
<ul class="cm-outcome-list"><li><span>01</span><div><h3>Focus the work</h3><p>Use market research.</p></div></li><li><span>02</span><div><h3>See the effort</h3><p>Review the team.</p></div></li></ul></div></section>
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
    // The site lists its primary audience's five settings first (owner decision 2026-11-16); the rest are secondary markets.
    expect(catalog.settings.map(setting => setting.name)).toEqual(['Home health agencies', 'Hospice agencies', 'Hospitals', 'Nursing homes', 'Personal care homes']);
    expect(catalog.settings[2]).toEqual({ name: 'Hospitals', text: 'Support your marketing plan.' });
    expect(catalog.otherSettings).toEqual([{ name: 'Behavioral health', text: 'Support your marketing plan.' }]);
    // Manager outcomes come from their own section, never from cards after the care settings.
    expect(catalog.managers).toEqual([{ name: 'Focus the work', text: 'Use market research.' }, { name: 'See the effort', text: 'Review the team.' }]);
    // Purchasing belongs to the fact sheet, which reads Intel's own catalog.
    expect(catalog.faq).toEqual([{ question: 'Is CareMetric Intel a CRM?', answer: 'Yes.' }]);
    expect(catalog.caveats).toEqual(['Feature availability, territory and usage limits vary by plan.']);
    expect(JSON.stringify(catalog)).not.toMatch(/WellSky|MatrixCare|HCHB|Axxess/);
  });

  it('stops rather than let another product\'s name through', () => {
    expect(() => extractIntel(homePage, featuresPage(' Works alongside Trella.'))).toThrow(/Another product is named/);
  });
});

// CareBase's pages, cut down to one of each part, in the shape of their markup (attributes included, as the extractor strips them): the
// features page's capability index (one card per area, inside <section id="capability-index">), its other sections, and the home page.
const carebaseFeatures = ({ published = 3, extra = '' } = {}) => `<section class="a"><p class="x"><span aria-hidden="true" class="dot"></span>The full capability index</p><h1 class="h">Everything CareBase does</h1><div><p class="y">Explore resident care, training and eMAR. Start with Core.</p></div>
<ul aria-label="Highlights"><li><span class="b"><svg viewBox="0 0 1 1"><path d="M0"/></svg>${published}<!-- --> capabilities across <!-- -->2<!-- --> areas</span></li></ul></section>
<section id="capability-index" class="c"><div><div><div class="d"><p class="e"><span aria-hidden="true" class="dot"></span>Find your next workflow</p><h2 class="f">A whole facility’s work. <em>One connected platform.</em></h2><p class="g">Explore every capability below.</p></div><div class="h"><p class="i">A plan that fits your facility</p><p class="j">Core covers resident operations. Add training or eMAR.</p><a href="/#pricing" class="k">Compare plans &amp; pricing<svg viewBox="0 0 1 1"><path d="M0"/></svg></a></div></div>
<div class="l"><label for="capability-search">Search capabilities</label><div class="m"><input inert id="capability-search" type="search" value=""/></div><div class="n" role="group" aria-label="Filter capabilities by area"><button inert type="button" aria-pressed="true">All capabilities</button><button inert type="button" aria-pressed="false">Resident care</button><button inert type="button" aria-pressed="false">eMAR</button></div></div>
<div class="o"><p role="status" aria-live="polite" aria-atomic="true">${published}<!-- --> capabilities across <!-- -->2<!-- --> connected areas</p></div>
<div id="capability-results" class="p"><article id="resident-care" class="q"><span id="resident-operations" class="r" aria-hidden="true"></span><div class="s"><span aria-hidden="true" class="t"><svg viewBox="0 0 1 1"><path d="M0"/></svg></span><span class="u">2<!-- --> capabilities</span></div><h3 class="v">Resident care &amp; daily operations</h3><p class="w">Keep the whole resident journey together.</p><p class="x">CareBase Core</p><ul class="y"><li class="z"><span aria-hidden="true" class="dot"></span><span>Inquiry tracking, admissions &amp; move-in checklists</span></li><li class="z"><span aria-hidden="true" class="dot"></span><span>Census, rooms &amp; room-readiness tracking</span></li></ul></article>
<article id="medication-management" class="q"><div class="s"><span aria-hidden="true" class="t"></span><span class="u">1<!-- --> capability</span></div><h3 class="v">Medication management &amp; eMAR</h3><p class="w">Carry the order through the medication workflow.</p><p class="x">eMAR add-on · facility activation required</p><ul class="y"><li class="z"><span aria-hidden="true" class="dot"></span><span>Facility medication rounds &amp; pass setup</span></li>${extra}</ul><p class="n">Native eMAR requires facility enrollment.</p></article></div></div></section>
<section id="product-screens" class="c"><figure><figcaption><span>Resident records &amp; care</span><span>Actual CareBase screen · fictional demo data</span></figcaption></figure></section>
<section id="recently-shipped" class="c"><div><p>Explore three tools.</p></div><article class="a"><div class="b"><span aria-hidden="true" class="c"></span><span class="d">In focus</span><span class="e">Survey Day Mode</span></div><h3 class="f">A single workspace</h3><p class="g">Open Survey Day Mode.</p></article></section>
<section id="resident-lifecycle" class="c"><ol class="a"><span aria-hidden="true" class="b"></span><li class="c"><div class="d"><span class="e">01</span><div><h3>Inquiry &amp; admission</h3><p>Track inquiries.</p></div></div></li></ol></section>
<section id="roles" class="c"><ul><li><div><span aria-hidden="true">01</span><h3>Facility manager</h3></div><p><span>Sees</span>assigned sites only.</p><p><span>Does</span>resolves gaps.</p></li></ul></section>`;
const carebaseHome = `<section><h1>Compliance on track.</h1><div><p class="hero">Manage staff training in one place.</p></div></section>
<section><p>In plain English</p><h2>One system</h2></div><p>CareBase brings records together.</p>
<div><div><span>01</span><span>Survey readiness</span></div><h3>Prepare for your next survey</h3><p>Keep supporting records together.</p></div></section>
<section><p>What sets it apart</p><h2>Built around the way Pennsylvania care works.</h2><div><div><span></span><span>01</span></div><h3>Pennsylvania is built into the workflow</h3><p>Chapters 2600 and 2800 differ.</p><p>Dementia requirements stay distinct.</p><p><span class="a"></span>Rules and timing that reflect your setting</p></div>
<div><div><span></span><span>02</span></div><h3>A readiness score organized by regulatory topic</h3><p>It is not a prediction of survey results.</p><p>See which tracked requirements need attention</p></div></section>
<section><p>Two chapters, one platform</p><div><span>55 Pa. Code Chapter 2600</span><h3>I run a personal care home</h3><p>12 hours of training a year.</p><p><strong>Records.</strong> Kept together.</p><ul aria-label="x"><li><span>12-hour annual training requirement</span></li></ul></div></section>
<section><ul><li><span><span>Before: </span>Sign-in sheets added up once a year</span><svg viewBox="0 0 1 1"><path d="M0"/></svg><span><span>With CareBase: </span>Hours logged as the training happens</span></li></ul></section>
<section><p>A free resource</p></section>`;
const carebaseFaq = `<script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"name":"What is CareMetric CareBase?","acceptedAnswer":{"text":"Software for staff training."}},
{"name":"How much does it cost?","acceptedAnswer":{"text":"$199."}},{"name":"Does it guarantee compliance or a deficiency-free survey?","acceptedAnswer":{"text":"No."}},
{"name":"Can a new organization start immediately?","acceptedAnswer":{"text":"You can begin signup online without a sales call. You can also explore demo options with fictional facility data before setting up your own organization."}}]}</script>`;
const readCarebase = page => extractCarebase({ home: carebaseHome, features: carebaseFeatures(page), faq: carebaseFaq });

describe('reading CareBase\'s published capabilities', () => {
  it('reads each area of the capability index, the newest tools, the lifecycle, the roles, why it matters, before and after, the chapters and the answers', () => {
    const catalog = readCarebase();
    expect(catalog.publishedCount).toBe(3);
    expect(catalog.publishedAreas).toBe(2);
    expect(catalog.overview).toBe('Manage staff training in one place.');
    expect(catalog.summary).toBe('CareBase brings records together.');
    expect(catalog.intro).toBe('Explore resident care, training and eMAR. Start with Core.');
    expect(catalog.legend).toBe('Core covers resident operations. Add training or eMAR.');
    expect(catalog.areas).toEqual([
      { key: 'resident-care', name: 'Resident care & daily operations', intro: 'Keep the whole resident journey together.', plan: 'CareBase Core', count: 2,
        capabilities: ['Inquiry tracking, admissions & move-in checklists', 'Census, rooms & room-readiness tracking'], note: null },
      { key: 'medication-management', name: 'Medication management & eMAR', intro: 'Carry the order through the medication workflow.', plan: 'eMAR add-on · facility activation required', count: 1,
        capabilities: ['Facility medication rounds & pass setup'], note: 'Native eMAR requires facility enrollment.' },
    ]);
    expect(catalog.newest).toEqual([{ name: 'Survey Day Mode', headline: 'A single workspace', does: 'Open Survey Day Mode.' }]);
    expect(catalog.lifecycle).toEqual([{ step: 'Inquiry & admission', text: 'Track inquiries.' }]);
    expect(catalog.roles).toEqual([{ role: 'Facility manager', sees: 'assigned sites only.', does: 'resolves gaps.' }]);
    // "What sets it apart" ends with its own section: the chapter cards after it are chapters, not reasons.
    expect(catalog.pillars).toEqual([
      { title: 'Prepare for your next survey', why: 'Keep supporting records together.', area: 'Survey readiness' },
      { title: 'Pennsylvania is built into the workflow', why: 'Chapters 2600 and 2800 differ. Dementia requirements stay distinct.', area: 'Rules and timing that reflect your setting' },
      { title: 'A readiness score organized by regulatory topic', why: 'It is not a prediction of survey results.', area: 'See which tracked requirements need attention' },
    ]);
    expect(catalog.beforeAfter).toEqual([{ before: 'Sign-in sheets added up once a year', after: 'Hours logged as the training happens' }]);
    expect(catalog.chapters).toEqual([{ chapter: '55 Pa. Code Chapter 2600', title: 'I run a personal care home', text: '12 hours of training a year. Records. Kept together.', highlights: ['12-hour annual training requirement'] }]);
    // Prices are the fact sheet's; demos and sales calls are never offered.
    expect(catalog.faq.map(item => item.question)).toEqual(['What is CareMetric CareBase?', 'Does it guarantee compliance or a deficiency-free survey?', 'Can a new organization start immediately?']);
    expect(catalog.faq.at(-1).answer).toBe('You can begin signup online on your own.');
    expect(catalog.caveats).toEqual(['It is not a prediction of survey results.', 'No.']);
  });

  it('keeps each area\'s own count beside what it lists, so the check sees a capability it did not count', () => {
    const [, medication] = readCarebase({ extra: '<li class="z"><span aria-hidden="true" class="dot"></span><span>Refill requests</span></li>' }).areas;
    expect(medication.capabilities).toHaveLength(2);
    expect(medication.count).toBe(1);
  });
});

describe('checking what was read from CareBase\'s pages', () => {
  const { check } = products.carebase;
  const committed = JSON.parse(readFileSync(new URL('../server/agents/content/carebase-features.json', import.meta.url), 'utf8'));
  const changed = edit => { const body = structuredClone(committed); edit(body); return () => check(body); };

  it('accepts the committed catalog, every area and capability the page counts', () => {
    expect(check(committed)).toMatch(/^\d+ areas, \d+ capabilities, \d+ reasons and \d+ answers$/);
  });

  it('fails loudly when the page changes shape again', () => {
    expect(changed(body => { body.areas = []; })).toThrow(/CareBase's pages changed shape \(areas 0, capabilities 0/);
    expect(changed(body => { body.areas[0].capabilities.pop(); })).toThrow(new RegExp(`partly read: ${committed.areas[0].key}`));
    expect(changed(body => { body.areas[1].plan = ''; })).toThrow(new RegExp(`partly read: ${committed.areas[1].key}`));
    expect(changed(body => { body.newest = []; })).toThrow(/newest 0/);
    expect(changed(body => { body.legend = ''; })).toThrow(/no intro or plan note/);
    expect(changed(body => { body.pillars.push({ ...body.pillars[0], title: body.chapters[0].title }); })).toThrow(/\(1 from the chapters\)/);
  });

  it('fails when the page\'s own figure is not what was read', () => {
    expect(changed(body => { body.publishedCount += 1; })).toThrow(new RegExp(`says ${committed.publishedCount + 1} capabilities across ${committed.publishedAreas} areas but ${committed.publishedCount} across`));
    expect(changed(body => { body.publishedAreas += 1; })).toThrow(/areas but/);
    expect(changed(body => { body.publishedCount = null; })).toThrow(/says no number of capabilities/);
  });
});
