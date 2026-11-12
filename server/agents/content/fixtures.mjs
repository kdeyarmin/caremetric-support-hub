/**
 * Model answers the Content Marketer's tests use: a draft for each kind of topic that passes every check, and outreach drafts
 * that pass. Tests change one field at a time to see a check fail. Synthetic text only.
 */
import { officialSources } from './facts.mjs';

const fireBody = `Fire drill records are among the documents surveyors can ask to see, and Pennsylvania's rules for personal care homes and Assisted Living Facilities read almost the same. Both § 2600.132 and § 2800.132 of 55 Pa. Code set out how often drills happen, what each one must include and what the written record shows.

## How often drills happen

Hold an unannounced fire drill at least once a month (§ 2600.132(a), § 2800.132(a)). Once a year, a fire safety expert completes a fire safety inspection and fire drill, and that drill and inspection are documented (§ 2600.132(b)). A drill is also held during sleeping hours once every 6 months (§ 2600.132(e)).

## What each drill includes

- Use alternate exit routes, so residents and staff practice more than one way out.
- Vary the day of the week and the time of day or night.
- Do not routinely hold drills when extra staff are present.
- Set off a fire alarm or smoke detector, and never use elevators.

## The written fire drill record

Each record includes the date, the time, how long the evacuation took, the exit route used, how many residents were present and how many were evacuated, how many staff took part, problems encountered, and whether the fire alarm or smoke detector worked (§ 2600.132(c), § 2800.132(c)).

## Keeping drills on schedule

A simple calendar with the next monthly drill, the next sleeping-hours drill and the yearly expert inspection keeps the schedule in view. **CareBase** keeps each drill's record in one place with the details above, so the team can see what is due and a surveyor can follow the history.`;

/** A fire drill article that passes every check (topic `pa-fire-drill-requirements`). */
export const fireDrillDraft = Object.freeze({
  title: 'Fire drill requirements for Pennsylvania personal care homes and ALFs',
  slug: 'pennsylvania-personal-care-home-alf-fire-drill-requirements',
  metaDescription: 'How often Pennsylvania personal care homes and ALFs hold fire drills, what each drill includes and what the written record must show.',
  summary: 'Hold an unannounced fire drill at least once a month, a sleeping-hours drill once every 6 months and a yearly expert drill, and keep a written record of each one with the details the regulation lists.',
  outline: ['How often drills happen', 'What each drill includes', 'The written fire drill record', 'Keeping drills on schedule'],
  body: fireBody,
  faq: [
    { question: 'How often must a Pennsylvania personal care home hold a fire drill?', answer: 'At least once a month, unannounced, plus a drill during sleeping hours once every 6 months (§ 2600.132(a) and (e)).' },
    { question: 'What goes in a written fire drill record?', answer: 'The date, the time, how long the evacuation took, the exit route, the residents present and evacuated, the staff who took part, problems and whether the alarm or detector worked.' },
  ],
  internalLinks: ['carebase-features', 'carebase-survey-guide'],
  citations: [officialSources['pacode-2600-132'].url, officialSources['pacode-2800-132'].url],
});

const referralBody = `Home health referrals grow from relationships, and relationships take time. A focused plan spends that time on the physicians, hospitals and community organizations most likely to need your agency, and keeps a record of what happened next.

## Research the territory first

Public data can show where to look. CMS publishes provider data about home health services at data.cms.gov, and comparing the practices and facilities around your service area points to the accounts worth a closer look. Treat those patterns as research signals: they do not confirm a referral.

## Build a focused account list

Give each account on the list a reason for being there, an owner on your team and a next step. A shorter list that the team can actually work beats a long one nobody follows up on.

## Prepare, visit and record

Before each visit, review the account's history and decide what the conversation should accomplish. Afterwards, record the activity and schedule the follow-up while it is fresh.

## Review the referrals you record

The referrals your agency records are the confirmed ones. Review them beside the outreach that preceded them, then decide what to continue and what to change. **CareMetric Intel** keeps the research, the outreach and the recorded referrals in one workspace, with a 30-day free trial.`;

/** A home health marketing article that passes every check (topic `home-health-referral-marketing`). */
export const referralDraft = Object.freeze({
  title: 'Home health referral marketing: building a focused outreach plan',
  slug: 'home-health-referral-marketing-focused-outreach-plan',
  metaDescription: 'A practical sequence for home health referral marketing: research the territory, focus the account list, follow up and review recorded referrals.',
  summary: 'Research the territory with public data, build a short account list with an owner and a next step for each, record every visit and follow-up, and review the referrals your agency records to decide what to change.',
  outline: ['Research the territory first', 'Build a focused account list', 'Prepare, visit and record', 'Review the referrals you record'],
  body: referralBody,
  faq: [
    { question: 'Does public Medicare data show which physicians refer to my agency?', answer: 'No. Public data patterns are research signals that show where to look; the referrals your agency records are the confirmed ones.' },
    { question: 'How long should a home health target list be?', answer: 'Short enough that every account has an owner and a next step the team will actually work, and reviewed against the referrals you record.' },
  ],
  internalLinks: ['intel-home', 'intel-targeted-marketing'],
  citations: [officialSources['cms-home-health'].url],
});

/** Outreach drafts that pass every check. */
export const outreachDraft = Object.freeze({
  listings: [
    { directory: 'capterra', product: 'carebase', tagline: 'Staff training, resident records and survey documentation for PA personal care homes',
      description: 'CareMetric CareBase keeps staff training, resident records, daily tasks and survey documentation in one place for Pennsylvania personal care homes and Assisted Living Facilities. Teams see what needs attention and keep records ready for a surveyor. CareBase Core is $199 per facility per month with unlimited residents and staff, and optional eMAR, Staff Training, Workforce, Survey & Compliance and Resident Billing & Payments modules. Start with a 30-day free trial at cmcarebase.com.' },
    { directory: 'g2', product: 'intel', tagline: 'Targeted marketing and territory analysis for home health and hospice teams',
      description: 'CareMetric Intel helps home health agencies, hospice agencies, hospitals, nursing homes and personal care homes focus their marketing. Research a territory with public healthcare and demographic data, build a focused account list, organize outreach and follow-up, and review the referrals your organization records. Plans start at $349 per month, and a 30-day free trial with no credit card covers one county.' },
  ],
  pitches: [
    { audience: 'provider_association', product: 'carebase', subject: 'A resource for your personal care home and ALF members',
      body: 'Pennsylvania personal care homes and Assisted Living Facilities spend a lot of time keeping training records, resident documentation and survey preparation in order. CareMetric CareBase keeps that work in one place and is built around Chapters 2600 and 2800. If it would help your members, I would be glad to share a short write-up for your newsletter or members page. Every member can try it free for 30 days at cmcarebase.com.' },
  ],
});

/** The Messages API answer the runtime reads for `output`. */
export const completion = (output, over = {}) => ({
  id: 'msg_content', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: JSON.stringify(output) }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 5200, output_tokens: 2400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, ...over,
});
