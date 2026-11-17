/**
 * The Content Marketer's backlog: the articles it may write, curated in code and reviewed like any change. Each topic says
 * which product it serves (the article is published under that product), whether it explains a regulation (those carry the
 * fixed "not legal advice" line), who it is for, what angle to take, the official sources it may cite and the facts it may
 * state. Every regulation fact below was read from the cited section of the Pennsylvania Code on 2026-11-03; a fact a topic
 * does not list is one the article may not state. Numbers in an article must come from these facts or the fact sheet.
 *
 * `chooseTopic` picks the next one: never a topic already published or still waiting for the owner, never one the owner
 * rejected in the last 90 days, favouring products whose inbox questions (counts only, never text) have been busiest lately
 * and turning away from the product the last article was about.
 */
import { officialSources, productPageIds } from './facts.mjs';

// Every Intel article suggests Intel's free market report first, the call to action the cold email and the ads lead with (team review
// 2026-11-17, stage 6: no article led to it).
const reportFirst = value => (value.product === 'intel' && !value.links.includes('intel-market-review') ? ['intel-market-review', ...value.links] : value.links);
const topic = value => Object.freeze({ ...value, facts: Object.freeze(value.facts), sources: Object.freeze(value.sources), links: Object.freeze(reportFirst(value)), keywords: Object.freeze(value.keywords) });

const pchAndAlf = 'Administrators and owners of Pennsylvania personal care homes and Assisted Living Facilities';

export const topics = Object.freeze([
  topic({
    key: 'pa-chapter-2600-vs-2800', product: 'carebase', kind: 'regulation', priority: 3,
    title: 'Personal care home or Assisted Living Facility? How Pennsylvania Chapters 2600 and 2800 differ',
    slug: 'pennsylvania-personal-care-home-vs-assisted-living-facility-rules',
    audience: `${pchAndAlf}, and operators deciding which license fits their building and residents`,
    angle: 'A plain comparison of the two licenses on the points staff feel every day: training hours, dementia training and fire drills. End with how CareBase keeps either kind of facility\'s records together.',
    keywords: ['personal care home vs assisted living Pennsylvania', '55 Pa. Code Chapter 2600', '55 Pa. Code Chapter 2800'],
    facts: [
      'Pennsylvania licenses personal care homes under 55 Pa. Code Chapter 2600 and assisted living facilities under 55 Pa. Code Chapter 2800.',
      'Direct care staff in a personal care home need at least 12 hours of annual training (§ 2600.65(e)). In an ALF the minimum is 16 hours (§ 2800.65(h)).',
      'In an ALF, direct care staff may not provide unsupervised assisted living services until they complete 18 hours of training (§ 2800.65(g)).',
      'ALF staff, administrative staff and volunteers need at least 4 hours of dementia-specific training within 30 days of hire and at least 2 hours every year after, on top of the 16 hours (§ 2800.69).',
      'Both chapters require an unannounced fire drill at least once a month (§ 2600.132(a), § 2800.132(a)).',
      'Both chapters apply the Department\'s licensing rules in 55 Pa. Code Chapter 20 except the rule on announced inspections (§ 2600.11(a), § 2800.11(a)).',
    ],
    sources: ['pacode-2600', 'pacode-2800', 'pacode-2600-65', 'pacode-2800-65', 'pacode-2800-69'],
    links: ['carebase-home', 'carebase-training-requirements', 'advisors-senior-living'],
    inquiries: ['sales', 'customer_service'],
  }),
  topic({
    key: 'pa-surveyor-visit-readiness', product: 'carebase', kind: 'regulation', priority: 3,
    title: 'Getting ready for a DHS surveyor visit at a Pennsylvania personal care home or ALF',
    slug: 'dhs-surveyor-visit-readiness-pennsylvania-personal-care-homes',
    audience: pchAndAlf,
    angle: 'What the surveyors may ask for, why the visit can come unannounced, and a calm routine that keeps records ready every day instead of in a rush before a visit.',
    keywords: ['DHS surveyor visit personal care home', 'Pennsylvania personal care home inspection', 'survey readiness ALF'],
    facts: [
      'The Department of Human Services inspects each licensed facility on site at least once every 12 months (55 Pa. Code § 20.31).',
      'Personal care homes and ALFs are not told the date of the annual inspection in advance: Chapters 2600 and 2800 apply Chapter 20 except its rule on announced inspections (§ 2600.11(a), § 2800.11(a)).',
      'Facilities are also subject to other announced and unannounced inspections, and to complaint inspections (§ 20.33).',
      'During an inspection the facility gives the Department\'s representatives full access to the facility and its records, and the chance to interview staff and the people it serves privately (§ 20.34).',
      'When surveyors find items of noncompliance, the facility submits an acceptable written plan to correct each one within an acceptable period of time (§ 20.52).',
    ],
    sources: ['pacode-20-31', 'pacode-20-33', 'pacode-20-34', 'pacode-20-52', 'pacode-2600-11', 'pacode-2800-11'],
    links: ['carebase-survey-guide', 'carebase-dhs-citations', 'advisors-survey-checklist'],
    inquiries: ['sales', 'technical_support', 'customer_service'],
  }),
  topic({
    key: 'pa-annual-inspection-records', product: 'carebase', kind: 'regulation', priority: 3,
    title: 'Annual inspection preparation: the records Pennsylvania personal care homes and ALFs should keep ready',
    slug: 'annual-inspection-records-checklist-pennsylvania-personal-care-homes',
    audience: pchAndAlf,
    angle: 'A records checklist organized by area (fire drills, training, resident rights, incidents, emergency plans), each item tied to its section, with a monthly habit for keeping it current.',
    keywords: ['personal care home annual inspection checklist', 'ALF inspection records Pennsylvania', 'PA DHS inspection preparation'],
    facts: [
      'The Department inspects each licensed facility on site at least once every 12 months, without announcing the date (§ 20.31, § 2600.11(a), § 2800.11(a)).',
      'Each written fire drill record includes the date, the time, how long the evacuation took, the exit route used, how many residents were present and how many were evacuated, how many staff took part, problems encountered, and whether the fire alarm or smoke detector worked (§ 2600.132(c), § 2800.132(c)).',
      'The medication administration training record names the staff person trained, the date, the source, the trainer, and shows that the course was completed (§ 2600.190(c), § 2800.190(c)).',
      'Each resident\'s record keeps a signed acknowledgment that the resident (and any designated person) received the rights and complaint procedures, or notes the efforts made to get the signature (§ 2600.41(e), § 2800.41(e)).',
      'The written emergency procedures are reviewed, updated and submitted every year to the local emergency management agency (§ 2600.107(d), § 2800.107(d)).',
      'The facility keeps a copy of every reportable incident report (§ 2600.16(f), § 2800.16(f)).',
    ],
    sources: ['pacode-20-31', 'pacode-2600-132', 'pacode-2600-190', 'pacode-2600-41', 'pacode-2600-107', 'pacode-2600-16'],
    links: ['carebase-survey-guide', 'carebase-features', 'advisors-survey-checklist'],
    inquiries: ['sales', 'technical_support'],
  }),
  topic({
    key: 'pa-staff-training-hours', product: 'carebase', kind: 'regulation', priority: 3,
    title: 'Annual staff training hours and records for Pennsylvania personal care homes and ALFs',
    slug: 'pennsylvania-personal-care-home-alf-staff-training-hours',
    audience: `${pchAndAlf}, and the staff who schedule training`,
    angle: 'How many hours each license requires, what must be covered, what counts toward the hours, and how to keep training records a surveyor can follow.',
    keywords: ['PA personal care home training hours', 'ALF annual training 16 hours Pennsylvania', '2600.65 training requirements'],
    facts: [
      'Direct care staff in a personal care home need at least 12 hours of annual training related to their job duties (§ 2600.65(e)).',
      'In a personal care home, orientation counts toward the 12 hours in the first year of employment, and on-the-job training may count for 6 of the 12 hours (§ 2600.65(e)).',
      'Direct care staff in an ALF need at least 16 hours of annual training, and the dementia-specific training in § 2800.69 is in addition to those 16 hours (§ 2800.65(h)).',
      'ALF staff need at least 4 hours of dementia-specific training within 30 days of hire and at least 2 hours every year after (§ 2800.69).',
      'Within 40 scheduled working hours, new staff are oriented in resident rights, the emergency medical plan, mandatory abuse reporting and reportable incidents (§ 2600.65(b), § 2800.65(e)).',
      'Every year, staff and regularly scheduled volunteers are trained in fire safety (by a fire safety expert or a staff person trained by one), emergency preparedness, resident rights, the Older Adult Protective Services Act, and falls and accident prevention (§ 2600.65(g), § 2800.65(j)).',
    ],
    sources: ['pacode-2600-65', 'pacode-2800-65', 'pacode-2800-69'],
    links: ['carebase-training-requirements', 'carebase-features', 'carebase-pricing'],
    inquiries: ['sales', 'technical_support', 'customer_service'],
  }),
  topic({
    key: 'pa-fire-drill-requirements', product: 'carebase', kind: 'regulation', priority: 2,
    title: 'Fire drill requirements for Pennsylvania personal care homes and Assisted Living Facilities',
    slug: 'pennsylvania-personal-care-home-alf-fire-drill-requirements',
    audience: pchAndAlf,
    angle: 'What each drill must include, how often, when the sleeping-hours drill is due, and what belongs in the written record.',
    keywords: ['personal care home fire drill requirements', '2600.132 fire drills', 'ALF fire drill Pennsylvania'],
    facts: [
      'An unannounced fire drill is held at least once a month (§ 2600.132(a), § 2800.132(a)).',
      'A fire safety expert completes a fire safety inspection and fire drill every year, and that drill and inspection are documented (§ 2600.132(b), § 2800.132(b)).',
      'Each written fire drill record includes the date, the time, how long the evacuation took, the exit route used, how many residents were present and how many were evacuated, how many staff took part, problems encountered, and whether the fire alarm or smoke detector worked (§ 2600.132(c), § 2800.132(c)).',
      'Residents must be able to evacuate within the time a fire safety expert set in writing within the past year, and that expert may not be a staff person of the facility (§ 2600.132(d), § 2800.132(d)).',
      'A drill is held during sleeping hours once every 6 months (§ 2600.132(e), § 2800.132(e)).',
      'Drills use alternate exit routes, happen on different days and at different times of day and night, are not routinely held when extra staff are present, set off a fire alarm or smoke detector, and never use elevators (§ 2600.132(f)-(j), § 2800.132(f)-(j)).',
    ],
    sources: ['pacode-2600-132', 'pacode-2800-132'],
    links: ['carebase-features', 'carebase-survey-guide'],
    inquiries: ['technical_support'],
  }),
  topic({
    key: 'pa-reportable-incidents', product: 'carebase', kind: 'regulation', priority: 2,
    title: 'Reportable incidents in Pennsylvania personal care homes and ALFs: what to report and when',
    slug: 'pennsylvania-personal-care-home-alf-reportable-incidents',
    audience: `${pchAndAlf}, and the staff on duty when something happens`,
    angle: 'The reporting clock, who is told, the final report and the records to keep, with a simple incident routine.',
    keywords: ['reportable incidents personal care home Pennsylvania', '2600.16 reportable incidents', 'ALF incident reporting 24 hours'],
    facts: [
      'A personal care home reports a reportable incident or condition to the Department\'s regional office or the complaint hotline within 24 hours, in the way the Department designates (§ 2600.16(c)).',
      'An ALF reports to the Department\'s assisted living office or complaint hotline within 24 hours, and also tells the resident\'s family and designated person right away (§ 2800.16(c)).',
      'Reportable incidents include, among others listed in the regulation, the death of a resident and a serious injury that needs treatment at a hospital or medical facility (§ 2600.16(a), § 2800.16(a)).',
      'The facility keeps written policies on preventing, reporting, investigating and managing reportable incidents (§ 2600.16(b), § 2800.16(b)).',
      'A final report on the Department\'s form follows the end of the investigation, and if it confirms the incident, the affected resident and others who could be harmed (or their designated persons) are told (§ 2600.16(d)-(e), § 2800.16(d)-(e)).',
      'The facility keeps a copy of each report (§ 2600.16(f), § 2800.16(f)).',
    ],
    sources: ['pacode-2600-16', 'pacode-2800-16'],
    links: ['carebase-features', 'carebase-dhs-citations'],
    inquiries: ['technical_support', 'customer_service'],
  }),
  topic({
    key: 'pa-medication-administration-training', product: 'carebase', kind: 'regulation', priority: 2,
    title: 'Medication administration training for staff in Pennsylvania personal care homes and ALFs',
    slug: 'pennsylvania-medication-administration-training-personal-care-homes',
    audience: `${pchAndAlf}, and the people who schedule medication passes`,
    angle: 'Who may administer which medications, when the training must be current, the extra step for insulin, and the training record to keep.',
    keywords: ['medication administration training personal care home PA', '2600.190', 'ALF med pass training Pennsylvania'],
    facts: [
      'A staff person may administer oral, topical, and eye, nose and ear drop prescription medications and epinephrine injections for insect bites or other allergies after completing a Department-approved medications administration course, including the Department\'s performance-based competency test, within the past 2 years (§ 2600.190(a), § 2800.190(a)).',
      'Giving insulin injections also takes a Department-approved diabetes patient education program completed within the past 12 months (§ 2600.190(b), § 2800.190(b)).',
      'The training record names the staff person trained, the date, the source, the trainer, and shows that the course was completed (§ 2600.190(c), § 2800.190(c)).',
    ],
    sources: ['pacode-2600-190', 'pacode-2800-190'],
    links: ['carebase-features', 'carebase-training-requirements'],
    inquiries: ['technical_support', 'sales'],
  }),
  topic({
    key: 'pa-resident-rights-notices', product: 'carebase', kind: 'regulation', priority: 2,
    title: 'Resident rights notices in Pennsylvania personal care homes and ALFs',
    slug: 'pennsylvania-personal-care-home-alf-resident-rights-notices',
    audience: pchAndAlf,
    angle: 'What residents must be told at admission, how, what must be posted, and the signed acknowledgment that belongs in each record.',
    keywords: ['resident rights personal care home Pennsylvania', '2600.41 notification of rights', 'ALF resident rights poster'],
    facts: [
      'At admission, each resident (and any designated person) is told about resident rights and the right to complain without intimidation, retaliation or threats of retaliation (§ 2600.41(a), § 2800.41(a)).',
      'The notice is given in an easily understood way, in a language or mode of communication the resident uses (§ 2600.41(b), § 2800.41(b)).',
      'The Department\'s poster listing resident rights is posted in a conspicuous, public place (§ 2600.41(c), § 2800.41(c)).',
      'A copy of the rights and complaint procedures is given at admission, and a signed acknowledgment, or a note of the efforts made to get one, is kept in the resident\'s record (§ 2600.41(d)-(e), § 2800.41(d)-(e)).',
      'The specific rights themselves are listed in § 2600.42 and § 2800.42.',
    ],
    sources: ['pacode-2600-41', 'pacode-2800-41', 'pacode-2600-42', 'pacode-2800-42'],
    links: ['carebase-features', 'carebase-faq'],
    inquiries: ['customer_service'],
  }),
  topic({
    key: 'pa-emergency-preparedness', product: 'carebase', kind: 'regulation', priority: 1,
    title: 'Emergency preparedness plans for Pennsylvania personal care homes and ALFs',
    slug: 'pennsylvania-personal-care-home-alf-emergency-preparedness',
    audience: pchAndAlf,
    angle: 'What the written emergency procedures cover, the supplies to keep, and the yearly review and submission.',
    keywords: ['personal care home emergency preparedness Pennsylvania', '2600.107', 'ALF emergency plan'],
    facts: [
      'The administrator keeps a copy of, and is familiar with, the emergency preparedness plan of the municipality where the facility is located (§ 2600.107(a), § 2800.107(a)).',
      'The written emergency procedures include each resident\'s designated person contacts, a confidential way to provide residents\' emergency medical information, emergency management and housing contacts, transportation for relocation, staff duties during an evacuation, and alternate ways to meet resident needs during a utility outage (§ 2600.107(b), § 2800.107(b)).',
      'The facility keeps at least a 3-day supply of nonperishable food and drinking water for residents (§ 2600.107(c), § 2800.107(c)).',
      'The written emergency procedures are reviewed, updated and submitted every year to the local emergency management agency (§ 2600.107(d), § 2800.107(d)).',
    ],
    sources: ['pacode-2600-107', 'pacode-2800-107'],
    links: ['carebase-features', 'carebase-survey-guide'],
    inquiries: ['technical_support'],
  }),
  topic({
    key: 'home-health-referral-marketing', product: 'intel', kind: 'marketing', priority: 3,
    title: 'Home health referral marketing: building a focused outreach plan',
    slug: 'home-health-referral-marketing-focused-outreach-plan',
    audience: 'Owners, marketing managers and community liaisons at home health agencies',
    angle: 'A practical sequence from territory research to recorded referrals, with what public data can and cannot tell a marketer.',
    keywords: ['home health referral marketing', 'home health marketing plan', 'home health physician outreach'],
    facts: [
      'A focused plan follows one sequence: research the territory, build a focused account list, assign and prepare outreach, record activity and follow-up, then review recorded referrals and admissions.',
      'Public Medicare data can show where to look, but it does not confirm a referral: confirmed referrals are the ones the agency records itself.',
      'CMS publishes provider data about home health services at data.cms.gov.',
    ],
    sources: ['cms-home-health', 'cms-data'],
    links: ['intel-home', 'intel-targeted-marketing', 'intel-pricing'],
    inquiries: ['sales'],
  }),
  topic({
    key: 'county-market-data-outreach', product: 'intel', kind: 'marketing', priority: 2,
    title: 'Using county market data to plan home health and hospice outreach',
    slug: 'county-market-data-home-health-hospice-outreach',
    audience: 'Marketing managers at home health and hospice agencies planning a territory',
    angle: 'How to compare counties with demographic and provider data before committing a marketer\'s time, and the limits of that data.',
    keywords: ['county market data home health', 'hospice territory analysis', 'healthcare territory planning'],
    facts: [
      'The Census Bureau\'s American Community Survey publishes demographic estimates by county. They give planning context; they do not identify individual prospects.',
      'CMS publishes provider data about home health services and hospice care at data.cms.gov.',
      'Medicare figures describe the populations and periods included in each source, and their patterns do not confirm individual referrals.',
    ],
    sources: ['census-acs', 'cms-home-health', 'cms-hospice'],
    links: ['intel-territory-analysis', 'intel-home', 'intel-pricing'],
    inquiries: ['sales'],
  }),
  topic({
    key: 'hospice-relationship-plan', product: 'intel', kind: 'marketing', priority: 1,
    title: 'How a hospice agency can build a deliberate referral relationship plan',
    slug: 'hospice-referral-relationship-plan',
    audience: 'Hospice owners, executive directors and community educators',
    angle: 'Choosing the relationships to build, giving each one an owner and a next step, and reviewing the referrals the team records.',
    keywords: ['hospice referral relationships', 'hospice marketing plan', 'hospice community outreach'],
    facts: [
      'A focused plan follows one sequence: research the territory, build a focused account list, assign and prepare outreach, record activity and follow-up, then review recorded referrals and admissions.',
      'CMS publishes provider data about hospice care at data.cms.gov.',
      'Public data patterns are research signals; the referrals a hospice records are the confirmed ones.',
    ],
    sources: ['cms-hospice', 'cms-data'],
    links: ['intel-manager-playbook', 'intel-referral-measurement', 'intel-home'],
    inquiries: ['sales'],
  }),
  // More Intel topics (2026-11-12): Intel is the one product the team markets, and three topics lasted three weeks. Each states only
  // facts the three topics above already state, from the same official sources; the angle is method, never a claim about results.
  topic({
    key: 'referral-source-account-list', product: 'intel', kind: 'marketing', priority: 1,
    title: 'How to build a focused referral source list for a home health or hospice territory',
    slug: 'focused-referral-source-list-home-health-hospice',
    audience: 'Marketing managers and community liaisons at home health and hospice agencies',
    angle: 'Choosing which physicians, hospitals and facilities belong on a short account list, why a short list beats a long one, and how to keep it current.',
    keywords: ['referral source list home health', 'hospice referral sources', 'home health account list'],
    facts: [
      'A focused plan follows one sequence: research the territory, build a focused account list, assign and prepare outreach, record activity and follow-up, then review recorded referrals and admissions.',
      'CMS publishes provider data about home health services and hospice care at data.cms.gov.',
      'Public Medicare data can show where to look, but it does not confirm a referral: confirmed referrals are the ones the agency records itself.',
    ],
    sources: ['cms-home-health', 'cms-hospice', 'cms-data'],
    links: ['intel-targeted-marketing', 'intel-home', 'intel-county-report'],
    inquiries: ['sales'],
  }),
  topic({
    key: 'measuring-outreach-recorded-referrals', product: 'intel', kind: 'marketing', priority: 1,
    title: 'Measuring healthcare marketing outreach: activity, follow-up and recorded referrals',
    slug: 'measuring-healthcare-marketing-outreach-recorded-referrals',
    audience: 'Owners and marketing managers at home health and hospice agencies',
    angle: 'What to record after each visit, how to tell activity from outcomes, and why the referrals the agency records itself are the only confirmed ones.',
    keywords: ['measure home health marketing', 'referral tracking home health', 'hospice marketing metrics'],
    facts: [
      'A focused plan follows one sequence: research the territory, build a focused account list, assign and prepare outreach, record activity and follow-up, then review recorded referrals and admissions.',
      'Public Medicare data can show where to look, but it does not confirm a referral: confirmed referrals are the ones the agency records itself.',
      'Medicare figures describe the populations and periods included in each source, and their patterns do not confirm individual referrals.',
    ],
    sources: ['cms-data'],
    links: ['intel-referral-measurement', 'intel-manager-playbook', 'intel-home'],
    inquiries: ['sales'],
  }),
  topic({
    key: 'marketing-manager-weekly-review', product: 'intel', kind: 'marketing', priority: 1,
    title: 'A weekly review routine for home health and hospice marketing managers',
    slug: 'weekly-review-home-health-hospice-marketing-managers',
    audience: 'Directors of business development and marketing managers who lead marketers or community liaisons',
    angle: 'A short agenda a manager can repeat every week: planned visits, follow-ups that are due, accounts with no recent activity and the referrals recorded.',
    keywords: ['home health marketing manager', 'hospice business development', 'marketing team review'],
    facts: [
      'A focused plan follows one sequence: research the territory, build a focused account list, assign and prepare outreach, record activity and follow-up, then review recorded referrals and admissions.',
      'Public data patterns are research signals; the referrals a hospice records are the confirmed ones.',
    ],
    sources: ['cms-data'],
    links: ['intel-manager-playbook', 'intel-referral-measurement', 'intel-pricing'],
    inquiries: ['sales'],
  }),
  topic({
    key: 'new-county-market-research', product: 'intel', kind: 'marketing', priority: 1,
    title: 'Opening a branch or entering a new county: researching the market first',
    slug: 'entering-new-county-home-health-hospice-market-research',
    audience: 'Owners and administrators of home health and hospice agencies planning to expand',
    angle: 'What county demographic and provider data can show before an agency commits staff to a new county, and what only local relationships will tell.',
    keywords: ['home health expansion new county', 'hospice new market research', 'home health market analysis'],
    facts: [
      'The Census Bureau\'s American Community Survey publishes demographic estimates by county. They give planning context; they do not identify individual prospects.',
      'CMS publishes provider data about home health services and hospice care at data.cms.gov.',
      'Medicare figures describe the populations and periods included in each source, and their patterns do not confirm individual referrals.',
    ],
    sources: ['census-acs', 'cms-home-health', 'cms-hospice'],
    links: ['intel-territory-analysis', 'intel-county-report', 'intel-home'],
    inquiries: ['sales'],
  }),
  topic({
    key: 'public-data-limits-healthcare-marketing', product: 'intel', kind: 'marketing', priority: 1,
    title: 'What public Medicare and Census data can and cannot tell a healthcare marketer',
    slug: 'public-medicare-census-data-limits-healthcare-marketing',
    audience: 'Marketers, community liaisons and managers who plan outreach from public data',
    angle: 'A plain guide to reading public figures honestly: what each source covers, what it leaves out, and why it points to where to look rather than to who will refer.',
    keywords: ['medicare data marketing', 'census data healthcare marketing', 'public data home health'],
    facts: [
      'The Census Bureau\'s American Community Survey publishes demographic estimates by county. They give planning context; they do not identify individual prospects.',
      'CMS publishes provider data about home health services and hospice care at data.cms.gov.',
      'Medicare figures describe the populations and periods included in each source, and their patterns do not confirm individual referrals.',
      'Public Medicare data can show where to look, but it does not confirm a referral: confirmed referrals are the ones the agency records itself.',
    ],
    sources: ['census-acs', 'cms-home-health', 'cms-hospice', 'cms-data'],
    links: ['intel-territory-analysis', 'intel-targeted-marketing', 'intel-home'],
    inquiries: ['sales'],
  }),
  topic({
    key: 'small-marketing-team-focus', product: 'intel', kind: 'marketing', priority: 1,
    title: 'Where should a small home health marketing team spend its time?',
    slug: 'small-home-health-marketing-team-where-to-focus',
    audience: 'Owners and administrators of agencies with one to a few marketers',
    angle: 'How to choose a few counties and accounts on purpose, say no to the rest for now, and review the choice against the referrals the agency records.',
    keywords: ['small home health marketing team', 'home health marketing priorities', 'home health census growth'],
    facts: [
      'A focused plan follows one sequence: research the territory, build a focused account list, assign and prepare outreach, record activity and follow-up, then review recorded referrals and admissions.',
      'CMS publishes provider data about home health services at data.cms.gov.',
      'Public Medicare data can show where to look, but it does not confirm a referral: confirmed referrals are the ones the agency records itself.',
    ],
    sources: ['cms-home-health', 'cms-data'],
    links: ['intel-targeted-marketing', 'intel-how-it-works', 'intel-pricing'],
    inquiries: ['sales'],
  }),
  topic({
    key: 'new-marketer-territory-plan', product: 'intel', kind: 'marketing', priority: 1,
    title: 'A territory plan for a new home health marketer or community liaison',
    slug: 'territory-plan-new-home-health-marketer-community-liaison',
    audience: 'Managers onboarding a marketer or liaison, and marketers starting in a new territory',
    angle: 'What a new marketer needs on day one: the counties they own, a short account list, the next visit for each account and one place to record what happened.',
    keywords: ['new home health marketer', 'community liaison onboarding', 'home health territory plan'],
    facts: [
      'A focused plan follows one sequence: research the territory, build a focused account list, assign and prepare outreach, record activity and follow-up, then review recorded referrals and admissions.',
      'CMS publishes provider data about home health services and hospice care at data.cms.gov.',
      'Public Medicare data can show where to look, but it does not confirm a referral: confirmed referrals are the ones the agency records itself.',
    ],
    sources: ['cms-home-health', 'cms-hospice'],
    links: ['intel-manager-playbook', 'intel-how-it-works', 'intel-home'],
    inquiries: ['sales'],
  }),
  topic({
    key: 'hospice-community-outreach-by-county', product: 'intel', kind: 'marketing', priority: 1,
    title: 'Planning hospice community education and outreach by county',
    slug: 'planning-hospice-community-education-outreach-by-county',
    audience: 'Hospice executive directors, community educators and liaisons',
    angle: 'Using county demographic context and hospice provider data to decide where community education belongs, then recording which relationships it builds.',
    keywords: ['hospice community education', 'hospice outreach planning', 'hospice county data'],
    facts: [
      'The Census Bureau\'s American Community Survey publishes demographic estimates by county. They give planning context; they do not identify individual prospects.',
      'CMS publishes provider data about hospice care at data.cms.gov.',
      'Public data patterns are research signals; the referrals a hospice records are the confirmed ones.',
    ],
    sources: ['census-acs', 'cms-hospice'],
    links: ['intel-territory-analysis', 'intel-county-report', 'intel-home'],
    inquiries: ['sales'],
  }),
  topic({
    key: 'reading-county-data-before-outreach', product: 'intel', kind: 'marketing', priority: 1,
    title: 'Reading county data before you plan outreach: what to look at first',
    slug: 'reading-county-data-before-planning-healthcare-outreach',
    audience: 'Marketing managers and owners at home health and hospice agencies',
    angle: 'A walk through the county-level demographic and provider figures worth reading first, the questions each one raises, and how to turn them into a first account list.',
    keywords: ['county report home health', 'county healthcare data', 'home health county analysis'],
    facts: [
      'The Census Bureau\'s American Community Survey publishes demographic estimates by county. They give planning context; they do not identify individual prospects.',
      'CMS publishes provider data about home health services and hospice care at data.cms.gov.',
      'Medicare figures describe the populations and periods included in each source, and their patterns do not confirm individual referrals.',
      'A focused plan follows one sequence: research the territory, build a focused account list, assign and prepare outreach, record activity and follow-up, then review recorded referrals and admissions.',
    ],
    sources: ['census-acs', 'cms-home-health', 'cms-hospice'],
    links: ['intel-county-report', 'intel-territory-analysis', 'intel-targeted-marketing'],
    inquiries: ['sales'],
  }),
  topic({
    key: 'outreach-records-in-one-place', product: 'intel', kind: 'marketing', priority: 1,
    title: 'Keeping outreach, follow-up and referrals in one record instead of spreadsheets',
    slug: 'outreach-follow-up-referrals-one-record-not-spreadsheets',
    audience: 'Owners, managers and marketers who track visits and referrals in spreadsheets or several tools',
    angle: 'What gets lost when visits, follow-ups and referrals live in different places, and the few fields worth recording every time so a manager can see what came of the work.',
    keywords: ['home health marketing crm', 'referral tracking spreadsheet', 'hospice marketing crm'],
    facts: [
      'A focused plan follows one sequence: research the territory, build a focused account list, assign and prepare outreach, record activity and follow-up, then review recorded referrals and admissions.',
      'Public Medicare data can show where to look, but it does not confirm a referral: confirmed referrals are the ones the agency records itself.',
    ],
    sources: ['cms-data'],
    links: ['intel-how-it-works', 'intel-referral-measurement', 'intel-pricing'],
    inquiries: ['sales'],
  }),
  topic({
    key: 'pch-alf-acquisition-review', product: 'advisors', kind: 'regulation', priority: 2,
    title: 'What to review before buying a Pennsylvania personal care home or ALF',
    slug: 'buying-pennsylvania-personal-care-home-alf-due-diligence',
    audience: 'Buyers, owners and investors looking at Pennsylvania personal care homes and Assisted Living Facilities',
    angle: 'The licensing, inspection and operations questions to answer before a purchase, and where an independent review helps.',
    keywords: ['buying a personal care home Pennsylvania', 'assisted living acquisition due diligence', 'personal care home due diligence'],
    facts: [
      'The Department inspects each licensed facility on site at least once every 12 months (55 Pa. Code § 20.31).',
      'When surveyors find items of noncompliance, the facility submits an acceptable written plan to correct each one (§ 20.52).',
      'Pennsylvania licenses personal care homes under 55 Pa. Code Chapter 2600 and assisted living facilities under Chapter 2800.',
      'The Department of Human Services publishes personal care home reports on pa.gov.',
    ],
    sources: ['pacode-20-31', 'pacode-20-52', 'pacode-2600', 'pacode-2800', 'dhs-pch-reports'],
    links: ['advisors-acquisitions', 'advisors-acquisition-checklist', 'advisors-contact'],
    inquiries: ['advisors'],
  }),
  topic({
    key: 'outside-survey-readiness-review', product: 'advisors', kind: 'regulation', priority: 1,
    title: 'When an outside survey-readiness review helps a personal care home or ALF',
    slug: 'outside-survey-readiness-review-personal-care-home-alf',
    audience: 'Owners and administrators of personal care homes and Assisted Living Facilities',
    angle: 'The signs that a fresh set of eyes is worth it, what a readiness review looks at, and how its findings turn into owners and dates.',
    keywords: ['survey readiness consultant personal care home', 'mock survey assisted living', 'plan of correction help'],
    facts: [
      'The Department inspects each licensed facility on site at least once every 12 months, without announcing the date (§ 20.31, § 2600.11(a), § 2800.11(a)).',
      'Facilities are also subject to complaint inspections (§ 20.33).',
      'When surveyors find items of noncompliance, the facility submits an acceptable written plan to correct each one within an acceptable period of time (§ 20.52).',
    ],
    sources: ['pacode-20-31', 'pacode-20-33', 'pacode-20-52'],
    links: ['advisors-senior-living', 'advisors-survey-checklist', 'advisors-contact'],
    inquiries: ['advisors'],
  }),
]);

const rejectedCoolOffDays = 90;
/** A topic whose article was published this long ago may be written again, as a new article for the quarter (team review 2026-11-17, stage 6). */
export const rewriteAfterDays = 91;
const openStatuses = new Set(['proposed', 'approved', 'auto_approved', 'executing']);
/** The quarter a moment falls in, for a rewritten topic's address: 2027-q1. */
export const quarterTag = moment => { const date = new Date(moment); return `${date.getUTCFullYear()}-q${Math.floor(date.getUTCMonth() / 3) + 1}`; };

/**
 * A county topic (team review 2026-11-17, stage 6; Settings → AI team → "Write articles about the roster's counties"): what an agency in
 * one of the roster's counties should look at in its market, pointing to Intel's free county report and market report. It states no
 * figure: the county's figures are in the report, and the article holds only the facts below and the fact sheet's. Null for a county
 * without a usable name or state.
 */
export function countyTopic({ countyFips, state, name }) {
  const full = String(name ?? '').replace(/[^A-Za-z .'-]/g, '').replace(/\s+/g, ' ').trim();
  // A Louisiana parish or an Alaska borough keeps its own word; anything else is a county.
  const kind = full.match(/\s(County|Parish|Borough|Census Area|Municipality)$/i)?.[1] ?? 'County';
  const county = full.replace(/\s+(County|Parish|Borough|Census Area|Municipality)$/i, '').trim();
  if (!/^[0-9]{5}$/.test(countyFips ?? '') || !/^[A-Z]{2}$/.test(state ?? '') || county.length < 2 || county.length > 40) return null;
  const place = `${county} ${kind.toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase())}`;
  const words = place.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  return topic({
    key: `county-${countyFips}`, product: 'intel', kind: 'marketing', priority: 2,
    title: `Home health and hospice in ${place}, ${state}: what to look at in the market`,
    slug: `home-health-hospice-${words}-${state.toLowerCase()}`,
    audience: `Owners, administrators and marketing leaders at home health agencies and hospices serving ${place}, ${state}`,
    angle: `The questions an agency in ${place} should be able to answer about its market (who leads it, which hospitals its residents use and which physicians Intel ranks highest as referral sources), and how Intel's free county report and free market report answer them from public Medicare data. State no figure about the ${kind.toLowerCase()}: the reports hold them.`,
    keywords: [`${place.toLowerCase()} home health`, `${place.toLowerCase()} hospice`, `home health market ${place.toLowerCase()}`],
    facts: [
      'Public Medicare data can show where to look, but it does not confirm a referral: confirmed referrals are the ones the agency records itself.',
      'CMS publishes provider data about home health services at data.cms.gov.',
    ],
    sources: ['cms-home-health', 'cms-data'],
    links: ['intel-county-report', 'intel-market-review', 'intel-home'],
    inquiries: ['sales'],
  });
}

/** How many of a topic's keywords a recent search query (Search Console) holds every longer word of. */
export const queryMatches = (item, queries) => item.keywords.reduce((total, keyword) => {
  const words = keyword.toLowerCase().split(/\s+/).filter(word => word.length > 3);
  return total + (words.length && queries.some(query => words.every(word => query.includes(word))) ? 1 : 0);
}, 0);

/**
 * The topic to write next, or null when every topic is taken.
 * `articles`: the latest content.publish action per topic ({ topic, slug, product, status, at }) from the database.
 * `takenSlugs`: suggested slugs another content item already uses.
 * `questions`: recent inbox conversations counted by product and inquiry type ({ product, inquiryType, conversations }).
 * `queries`: recent search queries people made (Search Console), lowercased; a topic whose keywords they hold is nudged up.
 * `rewrite` (reach, team review 2026-11-17, stage 6): a topic published more than a quarter ago is written again, as a new article under
 * the quarter's own address (before, every topic was written once and the backlog ran dry in six or seven weeks).
 */
export function chooseTopic({ backlog = topics, articles = [], takenSlugs = [], questions = [], queries = [], now = new Date(), rewrite = false } = {}) {
  const latest = new Map(articles.map(article => [article.topic, article]));
  const slugs = new Set(takenSlugs);
  for (const article of articles) if (article.status === 'executed' || openStatuses.has(article.status)) slugs.add(article.slug);
  const coolOff = now.getTime() - rejectedCoolOffDays * 86_400_000;
  const stale = now.getTime() - rewriteAfterDays * 86_400_000;
  const due = item => { const last = latest.get(item.key); return rewrite && last?.status === 'executed' && new Date(last.at).getTime() <= stale; };
  // A topic written again keeps its key and gets the quarter's own address; the article it replaces stays published, so the new one is
  // written afresh rather than copied, under that address.
  const again = item => Object.freeze({ ...item, rewrite: true, slug: `${item.slug.slice(0, 72)}-${quarterTag(now)}`,
    angle: `${item.angle} This is a new article for ${quarterTag(now).replace('-q', ', quarter ')}: an earlier article on this topic stays published, so write it afresh, with the suggested slug as given.` });
  const eligible = backlog.map(item => (due(item) ? again(item) : item)).filter(item => {
    const last = latest.get(item.key);
    if (slugs.has(item.slug)) return false;
    if (!last || due(item)) return true;
    if (last.status === 'executed' || openStatuses.has(last.status)) return false;
    // A rejected draft is left alone for a while; an expired or failed one may be tried again at once.
    return !(last.status === 'rejected' && new Date(last.at).getTime() > coolOff);
  });
  if (eligible.length === 0) return null;

  const byProduct = new Map();
  const byInquiry = new Map();
  for (const entry of questions) {
    const count = Number(entry.conversations) || 0;
    byProduct.set(entry.product, (byProduct.get(entry.product) ?? 0) + count);
    byInquiry.set(`${entry.product}:${entry.inquiryType}`, count);
  }
  const productSlug = { carebase: 'carebase', intel: 'caremetric-intel', advisors: 'advisors' };
  // The last article that was published or is waiting for the owner; a rejected draft does not count as written.
  const recent = articles.filter(article => article.status === 'executed' || openStatuses.has(article.status)).sort((a, b) => new Date(b.at) - new Date(a.at))[0];
  const score = item => {
    const slug = productSlug[item.product];
    const asked = byProduct.get(slug) ?? 0;
    const matching = item.inquiries.reduce((total, inquiry) => total + (byInquiry.get(`${slug}:${inquiry}`) ?? 0), 0);
    // Priority leads; questions nudge (a log, so a busy week cannot drown the backlog); the last article's product steps back.
    // The database names products by their Hub slug (caremetric-intel), the backlog by its key (intel): compare the slug.
    // Searches people already make for a topic's keywords (Search Console's recent queries) nudge it up too, by at most one.
    const searched = queries.length ? Math.min(queryMatches(item, queries), 2) : 0;
    return item.priority + Math.log2(1 + asked) * 0.5 + Math.log2(1 + matching) * 0.5 + searched * 0.5 - (recent && recent.product === slug ? 1 : 0);
  };
  // Highest score first; the backlog's own order breaks ties, so the choice is deterministic.
  return eligible.map((item, index) => ({ item, index, value: score(item) }))
    .sort((a, b) => b.value - a.value || a.index - b.index)[0].item;
}

/** Problems with the backlog itself (a test keeps this empty): unknown sources or pages, duplicate keys or slugs. */
export function backlogProblems(backlog = topics) {
  const problems = [];
  const keys = new Set();
  const slugs = new Set();
  for (const item of backlog) {
    if (keys.has(item.key)) problems.push(`${item.key}: duplicate key`);
    if (slugs.has(item.slug)) problems.push(`${item.key}: duplicate slug`);
    keys.add(item.key); slugs.add(item.slug);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.key) || item.key.length > 80) problems.push(`${item.key}: key format`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug) || item.slug.length > 80) problems.push(`${item.key}: slug format`);
    if (!['carebase', 'intel', 'advisors'].includes(item.product)) problems.push(`${item.key}: product`);
    if (!['regulation', 'marketing'].includes(item.kind)) problems.push(`${item.key}: kind`);
    for (const source of item.sources) if (!officialSources[source]) problems.push(`${item.key}: unknown source ${source}`);
    for (const link of item.links) if (!productPageIds.includes(link)) problems.push(`${item.key}: unknown page ${link}`);
    if (item.kind === 'regulation' && item.sources.length === 0) problems.push(`${item.key}: a regulation topic needs a source`);
  }
  return problems;
}
