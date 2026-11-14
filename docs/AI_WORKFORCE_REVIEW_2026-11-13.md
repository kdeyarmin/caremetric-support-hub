# AI workforce build-out (2026-11-13)

The November 12 review ([AI_WORKFORCE_REVIEW_2026-11-12.md](AI_WORKFORCE_REVIEW_2026-11-12.md)) found the team close to idle: 23
agencies found in four days, two qualified, one cold email sent, 87¢ of model spend in a week. Money and autonomy were not the limit:
who the team could find and reach was. This build-out widens both, and adds paid ads, the founder's own LinkedIn and a watchdog.

Owner decisions behind it (2026-11-13): named decision-makers with a paid contact-data service (each address waits for approval; this
replaces the November 4 role-address rule), drafts for the founder's personal LinkedIn (no direct mail, no call list), ads on LinkedIn,
Meta and Google search. Ground rules kept: every new capability ships off, nothing sends outside the approval path, no demos, calls or
meetings, no cold SMS, automated calls or fax, and Intel shares only public CMS and Census data.

Later the same day the owner chose to have the Hub find people and their addresses itself rather than pay a contact-data service:
Apollo is removed, and the Hub reads the CMS owners file, the NPI registry and the agency's own website, keeps an address the agency
publishes and, if the owner allows it, asks the agency's mail server which of the usual address shapes is real
([CUSTOMER_GROWTH.md](CUSTOMER_GROWTH.md#finding-decision-makers-and-their-addresses)).

## What the team can do now

| Area | What changed | Turn it on |
| --- | --- | --- |
| Prospects | The Marketing Manager reads Intel's roster of every Medicare-certified home health agency and hospice in your states, ranks them (newly certified, new owner, size), confirms each one's own website (its CMS telephone number on the page, or its name and place: its state, or its city on a page that names no other state) and adds it to the pipeline with dated public-record evidence | Customer growth → Find prospects from the Medicare roster, States to prospect in |
| Replies and leads | Replies are read from the sender's own words (quoted text ignored, another mailbox at the agency counts, "no" read first); a trial links to the prospect it came from; county report, contact and savings-model leads get a two-email follow-up; a "not now" or a silent prospect is asked once more after 90 days, never after a no; before that re-ask the contact finder reads the agency's own site again, so its public address is re-verified and the evidence is current (a person's address verified more than 80 days earlier is not re-asked) | Customer growth → Follow up website leads by email, Days before asking again |
| Draft quality | Numbers and percentages stated in the evidence are allowed in a sentence about the agency, never in one about CareMetric or in the first person ("we cover 12 counties"); a failed draft gets one repair pass, and why drafts fail is counted on each run | Always on |
| Named people | Who CMS lists as owning the agency, its NPI record's authorized official and the leaders its own website names, and the deciding person's work address on the agency's own domain: one the agency publishes, or one its mail server confirms; each waits for you on Growth. Lists can be imported as CSV or through the signed import endpoint | Customer growth → Finding people's addresses, Most address checks a day |
| Research | One prospect at a time, researched with web search and page reading within a cost ceiling; only facts tied to an address the tools returned are kept | Customer growth → Research prospects with web search |
| Learning | Each Monday a short memo, written by code from 90 days of counts (replies by message type, objections, checks drafts failed, your notes on drafts you turned down). Drafts use it only after you choose "Use this memo" on Growth. The Monday scorecard shows visits from each outreach email tag | Customer growth → Write from what is working |
| Creative | County snapshots: one public Medicare or Census number for a county where your prospects are, printed by code with its source; the model writes only the words around it | Creative → County snapshots a week |
| Your videos | A finished video you upload (an intro, a commercial) becomes approved creative for each placement it fits, 16:9 included for Facebook and LinkedIn; the Social Media Manager uses it in its next weekly plan, and each post still waits for you | Creative → Add a finished video |
| Social | One post a week may be about a CMS release Intel just loaded or an observance starting soon; posts may link to articles published in the last 45 days; up to two approved story images a week are proposed for Instagram or the Facebook Page | Social media → Post about new CMS data and observances (stories and article links need nothing) |
| Founder | A few posts a week in your voice for your own LinkedIn profile. You approve each one and none is ever automatic; without your personal token they are emailed to copy | Social media → Write posts for my LinkedIn profile |
| Paid ads | Once a month per product: a LinkedIn campaign (draft), a Meta retargeting campaign (paused) and a Google search campaign (paused, or emailed as a Google Ads Editor file until the API is set up). A new LinkedIn or Meta campaign starts with no ads: you add its first ad in the platform's ad manager, from your approved creative, and the daily ad review proposes more once one is running. Leads from a Meta or LinkedIn ad click can be reported back to that platform by a hashed work email. Growth's roster panel downloads the LinkedIn company-list file | Paid ads → Most to spend on new campaigns a month, Report leads to the ad platforms |
| The team itself | Tasks run side by side (a slow one no longer stalls the rest); the morning brief and Monday scorecard name quiet agents, failing or stuck work and a stalled funnel stage, with the likely cause; a step is handed over only with at least ten of your decisions and at most a fifth turned down | AI team → Tasks at once, Days before an idle agent is flagged |

Intel's side: the marketing feed gained `include` details on the roster, `agency_facts`, `releases`, `observances` and a short source
line per county figure; public website sessions record the outreach email tag they came from; lead forms keep ad click IDs (Intel
`docs/HUB_MARKETING_FEED.md`, `docs/WEBSITE_SESSION_METRICS.md`).

## Owner checklist (nothing changes until these are done)

1. **Railway secrets** on the Hub: `HUB_INTEL_FEED_SECRET` (the same value as Intel's `HUB_MARKETING_FEED_SECRET`, set on Intel too);
   `HUB_GROWTH_IMPORT_SECRET` if lists will be sent to the import endpoint; for Google search
   through the API, nothing new: the Hub signs in as its Google service account (`HUB_SEARCH_CONSOLE_CREDENTIALS`) once it
   is a Standard user in Google Ads and Settings → Paid ads → Google Ads customer id is set.
2. **Email sender**: set and warm the growth sender (Settings → Email → Growth email sender). Raise "Most cold emails a day" in steps,
   10, then 25, then 50, while bounces stay under 2% and there are no complaints.
3. **Settings → Customer growth**, in this order: choose the roster states and turn on the roster; then website lead follow-up; then
   how far to go for people's addresses; then research with web search. Keep cold email on approval for the first roster week and read the first
   drafts on Growth. Turn on "Write from what is working" once a memo appears there.
4. **Settings → Creative**: leave County snapshots a week at 3, or 0 to stop them.
5. **Connections** (Settings → Social media): save your personal LinkedIn token on the LinkedIn card for founder posts; connect the
   LinkedIn and Meta ad accounts; in Ads Manager create a Custom Audience of website visitors and save its id under Paid ads; set the
   Meta Pixel id and Insight Tag on Intel; apply for Google Ads API access for your Google Cloud project.
6. **Your videos**: on Creative → Add a finished video, upload each cut of the CareMetric Intel intro and commercial (the social-sized
   files, under 60 MB), tick where each may be used and attest that it shows no personal information.
7. **Paid ads**: set "Most to spend on new campaigns a month" (and keep the daily ad-set limit under Social media). Turn on "Report
   leads to the ad platforms" only once your privacy notice says so (Intel's now does).

## Risks to watch

- **Wrong-site matches** could email the wrong agency: the roster confirms by the CMS telephone number (or name and place, never a
  page that places it in another state, and never a bare state code such as IN or OR, which are ordinary words), blocks a
  host shared by unrelated agencies, and the assessment cross-checks; keep cold email on approval for the first week.
- **Search quota**: roster look-ups add about 750 searches a month at 25 a day.
- **LinkedIn and Google targeting** use public identifiers (United States, Hospitals and Health Care, manager level and up; Google's
  United States location). Campaigns start as drafts or paused: review targeting before starting them.
- **API versions**: Google Ads defaults to v26 (Settings → Paid ads); Meta to the version under Social media.

## Connectors for your own Claude sessions

These help you, not the Hub's server agents (which use the integrations above): connect Gmail and Google Calendar and reconnect
Stripe; consider Clay for building lists in chat (then import them on Growth), Windsor.ai or Supermetrics for one view of
LinkedIn, Meta, Google Ads and Search Console, Canva for hand-finished creative, Ahrefs or Semrush for keywords, and Typefully only if
X or Threads are wanted later.
