import { describe, expect, it } from 'vitest';
import { extract } from './refresh-intel-features.mjs';

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
    const catalog = extract(homePage, featuresPage());
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
    expect(() => extract(homePage, featuresPage(' Works alongside Trella.'))).toThrow(/Another product is named/);
  });
});
