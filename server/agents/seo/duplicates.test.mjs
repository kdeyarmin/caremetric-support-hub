import { describe, expect, it } from 'vitest';
import { crossHostDuplicates } from './duplicates.mjs';
import { sites } from './sites.mjs';

const page = (url, title, over = {}) => ({ url, title, description: 'd', canonical: url, text: 't', words: 120, noindex: false, appShell: false, ...over });
const audit = (key, pages, over = {}) => ({ key, label: key, checked: pages.length, findings: [], pages, ...over });
const cleanWeek = () => [
  audit('advisors', [page('https://caremetricadvisors.com/', 'Healthcare advisory | CareMetric Healthcare Advisors')]),
  audit('carebase', [page('https://cmcarebase.com/', 'CareMetric CareBase — Survey-Ready Operations')]),
  audit('intel', [page('https://www.caremetricintel.com/', 'CareMetric Intel | Set your marketing on FIRE!')]),
  audit('help', [page('https://help.caremetric.ai/', 'CareMetric Support Hub')]),
];

describe('two of the company\'s hosts serving the same page', () => {
  it('finds nothing when every site is its own', () => {
    expect(crossHostDuplicates(cleanWeek(), sites)).toEqual([]);
  });

  it('asks for one canonical home page when two sites are both home pages for one product', () => {
    const audits = [...cleanWeek(), audit('carebase_home', [page('https://home.cmcarebase.com/', 'CareBase by CareMetric')])];
    expect(crossHostDuplicates(audits, sites)).toEqual([{
      hosts: ['cmcarebase.com', 'home.cmcarebase.com'], urls: ['https://cmcarebase.com/', 'https://home.cmcarebase.com/'], product: 'CareBase', reasons: ['same_product'], sharedTitles: 0,
    }]);
  });

  it('finds a canonical link that names another of the company\'s hosts, a variant host included', () => {
    const audits = cleanWeek();
    audits[2].pages.push(page('https://www.caremetricintel.com/about', 'About CareMetric Intel', { canonical: 'https://caremetrictrain.com/about' }));
    expect(crossHostDuplicates(audits, sites)).toEqual([{
      hosts: ['caremetrictrain.com', 'www.caremetricintel.com'], urls: ['https://caremetrictrain.com/about', 'https://www.caremetricintel.com/about'], product: null, reasons: ['canonical'], sharedTitles: 0,
    }]);
    // A canonical link to a host that is not the company's is the per-site check's business, not this one's.
    const stranger = cleanWeek();
    stranger[1].pages[0].canonical = 'https://elsewhere.test/';
    expect(crossHostDuplicates(stranger, sites)).toEqual([]);
  });

  it('finds the same title on two hosts whatever its case and spacing, once per pair of hosts, and counts the titles', () => {
    const audits = cleanWeek();
    audits[1].pages.push(page('https://cmcarebase.com/pricing', 'Plans and Pricing'), page('https://cmcarebase.com/faq', 'Questions'));
    audits[3].pages.push(page('https://help.caremetric.ai/pricing', '  plans and   pricing '), page('https://help.caremetric.ai/faq', 'questions'), page('https://help.caremetric.ai/faq-2', 'Questions'));
    expect(crossHostDuplicates(audits, sites)).toEqual([{
      hosts: ['cmcarebase.com', 'help.caremetric.ai'], urls: ['https://cmcarebase.com/pricing', 'https://help.caremetric.ai/pricing'], product: null, reasons: ['same_title'], sharedTitles: 2,
    }]);
  });

  it('lists every reason a pair has, with the home pages as the example when they are part of it', () => {
    const audits = [...cleanWeek(), audit('carebase_home', [
      page('https://home.cmcarebase.com/', 'CareMetric CareBase — Survey-Ready Operations', { canonical: 'https://cmcarebase.com/' }),
    ])];
    expect(crossHostDuplicates(audits, sites)).toEqual([{
      hosts: ['cmcarebase.com', 'home.cmcarebase.com'], urls: ['https://cmcarebase.com/', 'https://home.cmcarebase.com/'], product: 'CareBase', reasons: ['same_product', 'canonical', 'same_title'], sharedTitles: 1,
    }]);
  });

  it('leaves out a site that redirects to another, one that failed, and pages kept out of search', () => {
    const redirected = [...cleanWeek(), audit('carebase_home', [], { redirectsTo: 'https://cmcarebase.com', checked: 0 })];
    expect(crossHostDuplicates(redirected, sites)).toEqual([]);
    const failed = [...cleanWeek(), audit('carebase_home', [page('https://home.cmcarebase.com/', 'x')], { failed: true })];
    expect(crossHostDuplicates(failed, sites)).toEqual([]);
    const hidden = [...cleanWeek(), audit('carebase_home', [page('https://home.cmcarebase.com/', 'CareMetric CareBase — Survey-Ready Operations', { noindex: true })])];
    expect(crossHostDuplicates(hidden, sites)).toEqual([]);
    // Nor does a canonical link on a page kept out of search results, which competes with nothing.
    const hiddenCanonical = cleanWeek();
    hiddenCanonical[2].pages.push(page('https://www.caremetricintel.com/old', 'An old Intel page', { canonical: 'https://cmcarebase.com/', noindex: true }));
    expect(crossHostDuplicates(hiddenCanonical, sites)).toEqual([]);
    hiddenCanonical[2].pages.at(-1).noindex = false;
    expect(crossHostDuplicates(hiddenCanonical, sites).map(entry => entry.reasons)).toEqual([['canonical']]);
  });

  it('is the same for the same audits, whatever order they come in', () => {
    const audits = [...cleanWeek(), audit('carebase_home', [page('https://home.cmcarebase.com/', 'CareMetric Support Hub')])];
    expect(crossHostDuplicates([...audits].reverse(), sites)).toEqual(crossHostDuplicates(audits, sites));
    expect(crossHostDuplicates(audits, sites).map(entry => entry.hosts)).toEqual([['cmcarebase.com', 'home.cmcarebase.com'], ['help.caremetric.ai', 'home.cmcarebase.com']]);
  });
});
