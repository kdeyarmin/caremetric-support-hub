import { describe, expect, it } from 'vitest';
import { currentPage, navSections, visibleNavSections, type NavViewer } from './navigation';

const customer: NavViewer = { staff: false, platformAdmin: false, organizationBilling: false };
const billingCustomer: NavViewer = { ...customer, organizationBilling: true };
const staff: NavViewer = { staff: true, platformAdmin: false, organizationBilling: false };
const admin: NavViewer = { staff: true, platformAdmin: true, organizationBilling: false };

const outline = (viewer: NavViewer) => visibleNavSections(viewer).map(section => `${section.label}: ${section.items.map(item => item.label).join(', ')}`);
const paths = (viewer: NavViewer) => visibleNavSections(viewer).flatMap(section => section.items.map(item => item.to));

describe('sidebar navigation', () => {
  it('links every page once', () => {
    const all = navSections.flatMap(section => section.items.map(item => item.to));
    expect(new Set(all).size).toBe(all.length);
  });

  it('gives a customer a short list grouped by task, with organization billing only for billing administrators', () => {
    expect(outline(customer)).toEqual([
      'Home: Overview',
      'Support: Support cases',
      'Help & learning: Knowledge, User manuals, Learning library',
      'Platform: Products & contacts, App integration',
      'My account: Customer center, My profile & training, Security',
    ]);
    expect(paths(billingCustomer)).toContain('/billing');
  });

  it('adds the communications inbox for support staff but no administration', () => {
    expect(paths(staff)).toContain('/communications');
    for (const path of ['/admin', '/admin/apps', '/admin/leads', '/phone', '/phone-numbers', '/library', '/billing']) expect(paths(staff)).not.toContain(path);
  });

  it('shows administrators the control center first, the administration workspaces, and course authoring', () => {
    const sections = visibleNavSections(admin);
    expect(sections[0]).toMatchObject({ label: 'Home', items: [{ to: '/admin' }, { to: '/overview' }] });
    expect(sections[1].label).toBe('Administration');
    expect(paths(admin)).toEqual(expect.arrayContaining(['/admin/apps', '/admin/leads', '/admin/billing', '/admin/email', '/phone-numbers', '/phone', '/library']));
    // Administrators use platform billing, not the organization billing page.
    expect(paths(admin)).not.toContain('/billing');
  });
});

describe('current page', () => {
  const sections = visibleNavSections(admin);
  it.each([
    ['/admin', 'Home', 'Control center'],
    ['/admin/apps', 'Administration', 'Applications'],
    ['/admin/leads', 'Administration', 'Leads'],
    ['/admin/billing/customers/tenant-1', 'Administration', 'Billing'],
    ['/phone', 'Support', 'Phone messages'],
    ['/phone-numbers', 'Administration', 'Phone numbers'],
    ['/learn/my', 'Help & learning', 'Learning library'],
    ['/library/courses/new', 'Help & learning', 'Course authoring'],
    ['/help', '', 'Help'],
  ])('names %s as %s › %s', (pathname, section, label) => {
    expect(currentPage(sections, pathname)).toEqual({ section, label });
  });

  it('does not treat the control center as the parent of every administration page', () => {
    const control = sections[0].items[0];
    expect(control.end).toBe(true);
    expect(currentPage(sections, '/admin/unknown')).toBeNull();
  });

  it('only names pages the person can open', () => {
    expect(currentPage(visibleNavSections(customer), '/admin/apps')).toBeNull();
  });
});
