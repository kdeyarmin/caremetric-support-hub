import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import * as facts from './facts.mjs';
import {
  allowedAmounts, allowedHost, allowedPercents, articleUrl, citationHosts, claims, factSheetText, intelFactsFromCatalog, intelReviewedFacts, legalDisclaimer,
  officialSources, productPages, products, resetAppCatalogFacts, useAppCatalogFacts, articleHomeUrl, intelArticleOrigin, intelArticleUrl, servedElsewhere,
} from './facts.mjs';
import { allowedNumbers, namesCompetitor, textProblems } from './validate.mjs';
import { parseAppCatalog } from '../../app-catalog-sync.mjs';
import { foundersAgency } from '../../growth/draft.mjs';

const doc = readFileSync(new URL('../../../docs/GTM_FACTS.md', import.meta.url), 'utf8');

describe('the fact sheet', () => {
  it('states every price, percentage and trial length the agent may use in docs/GTM_FACTS.md as well', () => {
    expect(allowedAmounts.length).toBeGreaterThan(25);
    for (const amount of allowedAmounts) expect(doc, amount).toContain(amount);
    for (const percent of allowedPercents) expect(doc, percent).toContain(percent);
    expect(allowedPercents).toEqual(['17%', '75%']);
    expect(products.carebase.trialDays).toBe(30);
    expect(doc).toContain('a **30-day** free trial');
    expect(products.intel.trialDays).toBe(30);
    expect(doc).toContain('a **30-day** free trial');
    expect(products.advisors.trialDays).toBeNull();
  });

  it('uses the live per-facility CareBase price, never the retired flat $499 package', () => {
    expect(allowedAmounts).toContain('$199');
    expect(allowedAmounts).not.toContain('$499');
    expect(factSheetText()).not.toContain('$499');
    expect(products.carebase.pricing[0]).toMatch(/^CareBase Core: \$199 per facility per month/);
    expect(doc).toMatch(/CareBase Core is \$199 per facility per month/);
    expect(doc).toMatch(/MARKETING_SITE_REDESIGN_HANDOFF\.md[\s\S]{0,200}\$499/);
  });

  it('distinguishes base claims from the authorized sale and names each source', () => {
    expect(doc).toContain('the owner confirmed every fact, claim and rule on this page on 2026-11-08');
    expect(doc).not.toMatch(/owner to confirm/i);
    expect(doc).toContain('Founders Sale was requested by the owner on 2026-11-08');
    for (const product of Object.values(products)) expect(product.source).toMatch(/^kdeyarmin\/[A-Za-z]+@[0-9a-f]{7} /);
    for (const file of ['marketingPricing.ts', 'About.tsx', 'planCatalog.ts', 'marketing-copy.md', 'competitive-marketing-review.md', 'site-content.mjs']) expect(doc, file).toContain(file);
  });

  it('preserves legacy founding terms without offering them to new applicants', () => {
    const offer = products.carebase.offers.find(line => line.startsWith('Legacy founding partners'));
    expect(offer).toMatch(/pricing held for as long as they subscribe/);
    expect(offer).toMatch(/do not offer lifetime pricing to new applicants/);
    expect(offer).not.toMatch(/\bcall\b/i);
    expect(doc).toContain('founding-partner pricing locked for as long as they subscribe');
  });

  it('keeps the sale duration, renewal, exclusions and assisted trial redemption with both products', () => {
    for (const product of [products.carebase, products.intel]) {
      const offer = product.offers.find(line => line.startsWith('Founders Sale:'));
      expect(offer).toContain('75% off');
      expect(offer).toContain('first 12 months of paid service');
      expect(offer).toContain('including existing free-trial users');
      expect(offer).toContain('when paid service starts');
      expect(offer).toContain('Standard pricing resumes');
      expect(offer).toContain('custom contracts are excluded');
      expect(offer).toContain('Other promotional discounts cannot be combined');
      expect(offer).toContain('applied automatically');
    }
    expect(products.advisors.offers.join(' ')).not.toContain('FOUNDERS75');
  });

  it('allows a listed host and its subdomains, and nothing that merely contains one', () => {
    for (const host of ['pa.gov', 'www.pa.gov', 'dhs.pa.gov', 'www.pacodeandbulletin.gov', 'palegis.us', 'data.cms.gov', 'www.census.gov', 'cmcarebase.com', 'www.caremetricintel.com', 'help.caremetric.ai']) {
      expect(allowedHost(host), host).toBe(true);
    }
    for (const host of ['evilpa.gov', 'pa.gov.evil.test', 'cmcarebase.com.evil.test', 'caremetric.ai', 'example.com', '', null]) expect(allowedHost(host), String(host)).toBe(false);
    for (const host of citationHosts) expect(doc, host).toContain(host);
  });

  it('lists only https links and sources on allowed hosts, each once', () => {
    const urls = [...Object.values(officialSources).map(source => source.url), ...productPages.map(page => page.url)];
    expect(new Set(urls).size).toBe(urls.length);
    expect(new Set(productPages.map(page => page.id)).size).toBe(productPages.length);
    for (const value of urls) {
      const url = new URL(value);
      expect(url.protocol, value).toBe('https:');
      expect(allowedHost(url.hostname), value).toBe(true);
    }
    // The CareBase and Intel sites answer 200 for any path, so pricing is linked where it lives, on the home page.
    expect(productPages.find(page => page.id === 'carebase-pricing').url).toBe('https://cmcarebase.com/#pricing');
    expect(productPages.find(page => page.id === 'intel-pricing').url).toBe('https://www.caremetricintel.com/#pricing');
    // Checked on the live site on 2026-11-09: the home page carries id="how-it-works" and links /county-report.
    expect(productPages.find(page => page.id === 'intel-how-it-works').url).toBe('https://www.caremetricintel.com/#how-it-works');
    expect(productPages.find(page => page.id === 'intel-county-report').url).toBe('https://www.caremetricintel.com/county-report');
    // Intel retired its market review on 2026-11-19 (owner direction: nobody is asked for a CCN or an agency's name; the county report
    // serves every kind of organization). No page, capability or catalog feature offers it.
    expect(productPages.some(page => page.id === 'intel-market-review' || /market-review/.test(page.url))).toBe(false);
    expect(products.intel.capabilities.join('\n')).not.toMatch(/market review|market-review|\bCCN\b/);
    expect(products.intel.capabilities.find(line => line.startsWith('Competitor intelligence'))).toContain('a free county report anyone can request on Intel\'s site for any county, emailed as a PDF');
    for (const label of [...Object.values(officialSources).map(source => source.label), ...productPages.map(page => page.label)]) {
      expect(label, label).not.toMatch(/assisted living residence|\bALR\b|auditor/i);
    }
  });

  it('shows every agent Intel\'s bigger picture: everything it does by area, who uses it, and that email is never the point', () => {
    const text = factSheetText();
    const intel = products.intel;
    expect(text).toContain(`The bigger picture: ${intel.bigPicture}`);
    expect(text).toContain(`How to present it: ${intel.present}`);
    // Every "why it matters" area Intel publishes on its /features page.
    for (const area of ['Market and territory research', 'Healthcare data library', 'Prospecting and targeting', 'Healthcare marketing CRM', 'Daily field work', 'Expenses, mileage and reimbursement',
      'Referral and admission tracking', 'Competitor intelligence', 'Manager and team tools', 'Reports and analytics', 'Email campaigns', 'Administration, security and data']) {
      expect(intel.capabilities.some(line => line.startsWith(`${area}:`) || line.startsWith(`${area} [`)), area).toBe(true);
    }
    for (const line of [...intel.capabilities, ...intel.whoUses]) expect(text).toContain(`- ${line}`);
    expect(intel.present).toMatch(/sending emails to referral sources is not the point/);
    expect(intel.capabilities.find(line => line.startsWith('Email campaigns'))).toMatch(/never the point/);
    // Owner direction 2026-11-14: Intel is not a compliance product; expense tracking is a small part of it.
    expect(intel.present).toMatch(/not a compliance product/);
    expect(intel.present).toMatch(/never lead with compliance, the Stark limit or expense tracking/);
    expect(intel.capabilities.find(line => line.startsWith('Expenses, mileage'))).toMatch(/A small part of the workspace, never the point of it/);
    // The new text states no number, so it lets no draft state one (validate.mjs allowedNumbers) and makes no claim.
    const added = [intel.bigPicture, ...intel.capabilities, ...intel.whoUses, intel.present].join('\n');
    expect(added).not.toMatch(/\d/);
    expect(textProblems(added, { product: 'intel' }).filter(code => code !== 'personal_information')).toEqual([]);
  });

  it('shows every agent each area CareBase publishes, with the plan it needs, and keeps the human sheet aligned', () => {
    const text = factSheetText();
    const carebase = products.carebase;
    // One line per area on cmcarebase.com/features, in the page's order, with the page's own plan or add-on label in brackets.
    const { areas } = JSON.parse(readFileSync(new URL('./carebase-features.json', import.meta.url), 'utf8'));
    expect(carebase.capabilities.map(line => line.slice(0, line.indexOf(']:') + 1))).toEqual(areas.map(area => `${area.name} [${area.plan}]`));
    for (const line of [...carebase.capabilities, ...carebase.whyChoose, ...carebase.whoUses]) {
      expect(text).toContain(`- ${line}`);
      expect(doc, line).toContain(line);
    }
    // The page's own conditions travel with the areas they qualify.
    expect(carebase.capabilities.find(line => line.startsWith('Medication management'))).toMatch(/documented switch .* imported medication events are read-only/);
    expect(carebase.capabilities.find(line => line.startsWith('Survey readiness'))).toMatch(/readiness score does not predict survey results/);
    expect(carebase.capabilities.find(line => line.startsWith('Workforce'))).toMatch(/exclusion-list checks remain outside CareBase/);
    expect(carebase.capabilities.find(line => line.startsWith('Resident billing'))).toMatch(/alongside the accounting ledger and claims system/);
    // The summary states no number, so it lets no draft state one (validate.mjs allowedNumbers) and makes no claim.
    const added = [...carebase.capabilities, ...carebase.whoUses].join('\n');
    expect(added).not.toMatch(/\d/);
    expect(textProblems(added, { product: 'carebase' })).toEqual([]);
  });

  it('delivers all priority industries and their access conditions to agents and keeps the human sheet aligned', () => {
    const text = factSheetText();
    const { industryUseCases, industryGuidance } = products.intel;
    expect(industryUseCases.map(item => item.industry)).toEqual([
      'Home health agencies', 'Hospice agencies', 'Skilled nursing facilities and nursing homes',
      'Assisted Living Facilities and memory care communities', 'Personal care and residential care homes',
      'Hospitals and health systems', 'Durable medical equipment suppliers', 'Inpatient rehabilitation facilities',
      'Long-term care hospitals', 'Physician practices and medical groups',
    ]);
    for (const item of industryUseCases) {
      for (const value of Object.values(item)) {
        expect(text, item.industry).toContain(value);
        expect(doc, item.industry).toContain(value);
      }
    }
    for (const line of industryGuidance) {
      expect(text).toContain(line);
      expect(doc).toContain(line);
    }
    expect(industryGuidance.join(' ')).toMatch(/not measured customer usage/);
    // Standard plans offer every healthcare service line within their count of lines (kdeyarmin/intel@8abe4c6 planCatalog.ts).
    expect(industryGuidance.join(' ')).toMatch(/Standard plans offer CRM workflows for every healthcare service line/);
    expect([...industryGuidance, ...industryUseCases.flatMap(item => Object.values(item))].join(' ')).not.toMatch(/Enterprise agreement/);
    expect(industryGuidance.join(' ')).toMatch(/State-licensed residential coverage depends on which state files are loaded/);
    // New targeting guidance must not expand allowed numeric claims or conflict with the shared draft checks.
    const added = [...industryGuidance, ...industryUseCases.flatMap(item => Object.values(item))].join('\n');
    expect(added).not.toMatch(/\d/);
    expect(textProblems(added, { product: 'intel' }).filter(code => code !== 'personal_information')).toEqual([]);
  });

  it('gives every agent Intel\'s lead order, market context and boundaries from the research, with no number and no company name', () => {
    const text = factSheetText();
    const intel = products.intel;
    for (const line of [...intel.leadWith, ...intel.whyNow, ...intel.boundaries]) {
      expect(text).toContain(`- ${line}`);
      expect(doc, line).toContain(line);
    }
    expect(intel.leadWith).toHaveLength(5);
    // A number here would become one every draft may state (validate.mjs allowedNumbers); a company name would fail every draft.
    const added = [...intel.leadWith, ...intel.whyNow, ...intel.boundaries].join('\n');
    expect(added).not.toMatch(/\d/);
    expect(namesCompetitor(added)).toBe(false);
    expect(added.toLowerCase()).not.toMatch(/the best|the leading|number one|#1/);
    expect(textProblems(added, { product: 'intel' }).filter(code => code !== 'personal_information')).toEqual([]);
    // Owner direction 2026-11-14: expenses never lead, and the AI is text only.
    expect(intel.leadWith.join(' ')).not.toMatch(/expense|stark|compliance|email/i);
    expect(intel.leadWith.join(' ')).not.toMatch(/spoken|voice|dictat/i);
  });

  it('gives the founder\'s story in the owner\'s own words, with nothing a draft could not repeat', () => {
    const text = factSheetText();
    expect(text).toContain(`CareMetric's founder: ${facts.founder.name}`);
    for (const line of facts.founder.story) expect(text).toContain(`- ${line}`);
    expect(facts.founder.story.join(' ')).toMatch(/manage a home health and hospice company.*competitors.*referral source.*every day/);
    // The founder manages the company and owns no agency (owner correction 2026-11-27): no line says otherwise.
    expect([...facts.founder.story, facts.founder.storyAbout].join(' ')).not.toMatch(foundersAgency);
    const story = [...facts.founder.story, facts.founder.storyAbout, facts.founder.rules].join('\n');
    expect(story).not.toMatch(/\d/);
    for (const line of [...facts.founder.story, facts.founder.storyAbout]) expect(textProblems(line, { product: 'intel' }), line).toEqual([]);
    // A superlative is allowed in creative only when the fact source says it, so the sheet never spells one out, even as a "never".
    expect(text.toLowerCase()).not.toMatch(/the best|the leading|number one|#1/);
    expect(facts.founder.signOff).toEqual(['Dr. Kevin C. Deyarmin', 'Founder, CareMetric']);
  });

  it('opens with how everything must read: plain words, concrete, complete sentences', () => {
    const text = factSheetText();
    expect(text.indexOf('How everything must read:')).toBeLessThan(text.indexOf('CareMetric CareBase ('));
    for (const line of facts.writing) expect(text).toContain(`- ${line}`);
    expect(facts.writing.join(' ')).not.toMatch(/\d/);
  });

  it('shows the model the vocabulary, the claims it may not make and the disclaimer wording', () => {
    const text = factSheetText();
    for (const words of ['Assisted Living Facility', 'surveyors', '"prove", "proof" or "evidence"', 'text only', 'You may never say:']) expect(text, words).toContain(words);
    expect(claims.mayNot.join(' ')).toMatch(/ensures compliance/);
    expect(legalDisclaimer).toMatch(/not legal advice/);
    expect(articleUrl('pa-fire-drills')).toBe('https://help.caremetric.ai/help/articles/pa-fire-drills');
    // Intel's website serves Intel's articles, so their canonical address is there; every other product's stays in the help center.
    expect(intelArticleOrigin).toBe(new URL(products.intel.site).origin);
    expect(intelArticleUrl('home-health-referrals')).toBe('https://www.caremetricintel.com/resources/home-health-referrals');
    expect(productPages.find(page => page.id === 'intel-resources').url).toBe(`${intelArticleOrigin}/resources/`);
    expect([servedElsewhere('caremetric-intel'), servedElsewhere('carebase'), servedElsewhere('advisors'), servedElsewhere('toString')]).toEqual([true, false, false, false]);
    expect(articleHomeUrl('caremetric-intel', 'a-guide')).toBe('https://www.caremetricintel.com/resources/a-guide');
    expect(articleHomeUrl('carebase', 'a-guide')).toBe('https://help.caremetric.ai/help/articles/a-guide');
    expect(factSheetText()).toBe(text);
  });
});

describe("Intel's facts from its published catalog", () => {
  const fixture = JSON.parse(readFileSync(new URL('../../fixtures/intel-catalog.json', import.meta.url), 'utf8'));
  const catalog = (edit = body => body) => parseAppCatalog(edit(structuredClone(fixture)), 'caremetric-intel');
  const repriced = catalog(body => {
    body.version = 'abcdef0123456789';
    body.products.find(product => product.entitlement_key === 'growth').prices.find(price => price.interval === 'month').unit_amount = 94900;
    return body;
  });
  afterEach(() => resetAppCatalogFacts());

  it('writes exactly the reviewed lines from the catalog they were reviewed against', () => {
    expect(intelFactsFromCatalog(catalog())).toEqual(intelReviewedFacts);
    expect(useAppCatalogFacts('caremetric-intel', catalog())).toEqual([]);
    expect(products.intel.pricing).toEqual(intelReviewedFacts.pricing);
    expect(factSheetText()).toContain(`Intel catalog ${fixture.version}`);
  });

  it('quotes a new catalog price at once, checks drafts against it and flags the reviewed copy', () => {
    const before = facts.factsRevision;
    expect(useAppCatalogFacts('caremetric-intel', repriced)).toEqual(['$949']);
    expect(facts.factsRevision).toBe(before + 1);
    expect(products.intel.pricing[1]).toMatch(/^Growth: \$949 per month, or \$749 per month billed annually/);
    expect(facts.allowedAmounts).toContain('$949');
    expect(facts.allowedAmounts).not.toContain('$899');
    expect(factSheetText()).toContain('Intel catalog abcdef0123456789');
    expect(textProblems('Intel Growth is $949 per month.')).toEqual([]);
    expect(textProblems('Intel Growth is $899 per month.')).toContain('unlisted_price');
    expect(allowedNumbers([]).size).toBeGreaterThan(0);
    // The same catalog read again changes nothing.
    useAppCatalogFacts('caremetric-intel', repriced);
    expect(facts.factsRevision).toBe(before + 1);
  });

  it('goes back to the reviewed copy, and ignores catalogs of applications whose facts are reviewed by hand', () => {
    useAppCatalogFacts('caremetric-intel', repriced);
    resetAppCatalogFacts();
    expect(products.intel.pricing).toEqual(intelReviewedFacts.pricing);
    expect(facts.allowedAmounts).toEqual(allowedAmounts);
    expect(textProblems('Intel Growth is $949 per month.')).toContain('unlisted_price');
    expect(useAppCatalogFacts('carebase', repriced)).toEqual([]);
    expect(products.intel.pricing).toEqual(intelReviewedFacts.pricing);
  });
});
