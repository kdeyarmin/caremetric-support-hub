# Social media: the Social Media Manager

The Social Media Manager runs CareMetric's **Facebook Page**, **Instagram professional account**, **Meta ad account**, **LinkedIn
Company Page** and **LinkedIn ad account** for engagement. It plans and drafts posts, answers comments and messages, writes ad copy, evaluates every ad every day and changes what is
not working. Every post, reply and ad change waits for the owner's approval until the owner hands that kind of work over. A budget
increase always waits. It starts **paused, in Propose** (`20261108190000_social_manager.sql`, gate `20261108190100_social_manager_contract.sql`,
feature `platform.agents.social.v1`), with a daily model budget of $4.00 on the Draft tier.

LinkedIn connects through its own API once LinkedIn approves CareMetric's developer app (see "Connecting LinkedIn" below). Until then
the weekly plan still writes LinkedIn posts and emails them to the owner, ready to paste. Meta and LinkedIn are independent: either can
be connected alone.

Only the products switched on under **Products we market** on the AI team page are marketed: CareMetric Intel, while CareBase is in
its pilot (see "What the team markets" in [AI_TEAM.md](AI_TEAM.md)). Posts, links in replies, new ads and budget increases are for those products only; a
comment asking about another product is left for the owner, and a losing ad for one may still be paused.

## What it does

| Work (task) | When | What happens |
| --- | --- | --- |
| Weekly social plan (`social.plan`) | Each morning at 08:15 Eastern; plans once a week | Drafts 3 Facebook, 2 Instagram and 3 LinkedIn posts. It works from the fact sheet, the sales playbook and the last four weeks' engagement (more like what worked, never a repeat). Each draft is checked. Each post is proposed with a time slot (10:30 Eastern for Facebook, 12:15 for Instagram, 8:45 for LinkedIn); an approved post is held until then and published. The owner gets the plan by email, with the LinkedIn posts to paste while LinkedIn is not connected. |
| Comments and messages (`social.inbox`, `social.interaction`) | Every 15 minutes | Finds new comments on the Facebook Page's, Instagram's and the LinkedIn Page's recent posts, and new Messenger messages. Each gets its own task. With `HUB_AGENTS_CUSTOMER_TEXT_TO_AI=true` it drafts a short, checked reply for approval, or proposes hiding spam (deleting it on LinkedIn). Without it, the owner is told and answers on the platform. |
| Daily ad review (`social.ads`) | Each morning at 09:10 Eastern | Judges every Meta ad and LinkedIn creative on the last seven days against the seven before, with the rules below. It proposes pausing losers and new copy where an ad set needs it, plus a budget increase only under the owner's cap. |
| Weekly social report (`social.report`) | Each morning at 08:05 Eastern; sends once a week | Shows posts and engagement per platform, the top posts, and ad spend, impressions, click rate, results and cost per result per ad set. It also counts what is waiting for the owner. |

Instagram posts need an image. They use the brand images in `HUB_SOCIAL_IMAGE_URLS` in turn; with none, the plan leaves Instagram out.
LinkedIn posts use the same images, as the thumbnail of their link card: LinkedIn builds no preview for a post made through its API, so
the image is uploaded with the post. New ad copy reuses the image of the ad set's (or LinkedIn campaign's) best ad.

## How it judges ads

The rules are in `server/agents/social/rules.mjs` (`social-rules.1`), and every proposal shows its reason in plain words. An ad is judged
only after three days and 1,000 impressions or $20 of spend in the last seven days. Then, per active ad set:

- **Pause** an ad that is losing:
  - it spent at least $20 (or twice the target cost) with no result;
  - it costs more than twice the target per result; or
  - its click rate is under half the ad set's typical rate.

  The last active ad of an ad set is never paused; it is refreshed instead.
- **Refresh** (two new variants, each with a different angle) when:
  - an ad set has fewer than two active ads; or
  - an ad is tiring: seen more than 3.5 times per person, with its click rate down 30% on the week before.
- **Raise a budget** when an ad set has three or more results at 70% of the target cost or better. The step is at most 20%, never above
  `HUB_SOCIAL_AD_MAX_DAILY_BUDGET_CENTS`. With no cap set, no increase is ever proposed. The executor re-checks the cap, refuses a step
  over 25%, and refuses if the budget changed since the proposal. The database refuses any automatic approval of a budget change.

Results are leads and sign-ups as Meta and LinkedIn report them (LinkedIn: website conversions and Lead Gen Form leads). On LinkedIn a
campaign plays the part of an ad set (it holds the daily budget) and a creative the part of an ad, and the same rules apply. A new ad
runs inside the ad set's or campaign's existing budget, so pausing and adding ads never raises spend.

## What every word must pass

`server/agents/social/content.mjs` holds the three prompts (plan, ads, replies) and `checkSocialText`. Every post, reply and ad passes the
Content Marketer's fact-sheet rules:

- no price, percentage or number the fact sheet does not state;
- no guarantee, compliance assurance, certification or named competitor;
- no testimonial, no call or demo as a step, no voice AI, no "prove" about CareBase;
- the fixed vocabulary (ALF, surveyor).

It also passes these social rules:

- a length per surface (counted without campaign tags, which lengthen a link, not the words);
- no markup;
- links only to that product's own pages, plain or with campaign tags and nothing else, none in an Instagram caption or in ad text;
- at most five hashtags (eight on Instagram) and three emoji;
- only that product's prices;
- no promise of a refund, extension or special pricing;
- no claim about a person's personal attributes in an ad (Meta's advertising policy);
- no mention of AI;
- in a reply, nothing repeated from the person's message.

A draft that fails is dropped. The run records only the check's name.

**Campaign tags.** Every link the Social Media Manager places carries campaign tags, so a lead or a sign-up from it shows where it came
from (see "Campaign tags" in [AI_TEAM.md](AI_TEAM.md#campaign-tags)): a post's link (the card beside it, or the link in a LinkedIn
post to paste) is `utm_source` facebook, instagram or linkedin, `utm_medium=social`, `utm_campaign=social-<product>` and the post's
pillar as `utm_content`; a reply's is `social-<product>-reply` with `comment` or `message`; a new ad's is `utm_source` facebook (Meta,
which may also show it on Instagram) or linkedin, `utm_medium=paid_social`, `utm_campaign=ads-<product>` and `<date>-<variant>` as
`utm_content`. A new ad links to the page of the ad it is based on with that ad's old tags dropped, or to the free trial. When a post
is published the executor checks its link once more: one of the product's own pages, with campaign tags or without.

## Privacy

- Comments and messages are read from Meta or LinkedIn when they are handled and never stored in the Hub: no task, run, action or owner
  email holds another person's words.
- A public comment that appears to carry personal or health information is proposed for hiding, and the owner is warned, before any model
  sees it.
- Replies never discuss anyone's account, health or personal details in public; they invite a private message or support@caremetric.ai.
- Meta's 24-hour rule applies to messages: a message older than that is left for the owner.
- LinkedIn offers no API for a Page's private messages, so those always stay with the owner.
- LinkedIn has no "hide" for a comment, only delete, which cannot be undone. A LinkedIn deletion therefore always waits for the owner's
  own approval: once replies are handed over, a LinkedIn comment that should go is left for the owner instead, and the executor refuses
  an automatically approved deletion.
- The Meta token goes only to graph.facebook.com; the LinkedIn tokens go only to api.linkedin.com, to www.linkedin.com to renew them,
  and to the image upload address LinkedIn returns on a linkedin.com host. No token is ever shown or logged. Brand images are fetched
  without any credential.

## Setting it up

1. **In Meta Business Settings**, make sure CareMetric's Business owns the Facebook Page, the Instagram professional account (linked to
   the Page) and the ad account.
2. **Create a Meta app and a system user.** Create an app of the Business type and add it to the Business. Create a system user (Admin)
   and assign it the Page, the Instagram account and the ad account with full control. Generate a token for the app with:
   - pages: `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_posts`, `pages_manage_engagement`,
     `pages_messaging`;
   - Instagram: `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`;
   - ads: `ads_read`, `ads_management`;
   - `business_management`.

   Meta may ask for app review of some permissions before they work outside development mode.
3. **Set the Hub variables** on Railway:
   - required: `HUB_META_ACCESS_TOKEN` and `HUB_META_PAGE_ID`;
   - optional: `HUB_META_INSTAGRAM_ID`, `HUB_META_AD_ACCOUNT_ID`, `HUB_SOCIAL_IMAGE_URLS`, `HUB_SOCIAL_TARGET_COST_PER_RESULT_CENTS` and
     `HUB_SOCIAL_AD_MAX_DAILY_BUDGET_CENTS`.

   The Control center's integration panel shows which are set. To draft replies, `HUB_AGENTS_CUSTOMER_TEXT_TO_AI=true` and the Anthropic
   key are needed too.
4. **Apply the two migrations and restart the Hub** so it reads the feature. Then resume the Social Media Manager on **AI team**, in
   **Propose**, and press **Run now** on "Weekly social report" to check the connection, then on "Weekly social plan".
5. **Review a few weeks** of posts, replies and ad changes. Then hand work over one kind at a time under "Work the team does on its
   own". Each step runs a supervised week, then switches automatically:
   - **Social posts** (`social.post`);
   - **Social replies** (`social.reply` and hiding spam, `social.moderate`);
   - **Ad tuning** (`social.ad_pause` and `social.ad_create`).

   **Keep approving** takes a step back at any time, and **Pause** stops the agent.

A request Meta or LinkedIn may have received but did not confirm is never retried. It fails as `social_unconfirmed` and the owner is
asked to look at the Page, Ads Manager or Campaign Manager first. A token Meta or LinkedIn refuses (expired or missing a permission) is
reported to the owner once a day.

## Connecting LinkedIn

LinkedIn decides who may use its Page and advertising APIs. Approval is a review of CareMetric's use case and can take days to weeks.

1. **Be a super admin of CareMetric's LinkedIn Page**, and an account manager of the ad account in Campaign Manager.
2. **Create a developer app** at developer.linkedin.com for CareMetric, and have the Page verify it (Settings → Verify).
3. **Request the Community Management API** product for the app (posts, comments and engagement on the Page). LinkedIn reviews the
   request. LinkedIn may require this product to be the only one on its app.
4. **Request the Advertising API** product for ads: on the same app if LinkedIn allows, otherwise on a second app. If it is a second
   app, its token goes in `HUB_LINKEDIN_ADS_ACCESS_TOKEN` (and its refresh token, client id and secret in the matching `HUB_LINKEDIN_ADS_*`
   variables).
5. **Generate the tokens** (OAuth 2.0 authorization code flow, or the developer portal's token generator), signed in as the Page's admin:
   - Page app: `r_organization_social`, `w_organization_social` and `rw_organization_admin`, plus any comment scopes LinkedIn adds to
     the product (such as `r_organization_social_feed` and `w_organization_social_feed`);
   - ads app: `r_ads`, `rw_ads`, `r_ads_reporting`, `r_organization_social` and `w_organization_social` (sponsored-only posts carry each
     new ad's copy).

   An access token lasts 60 days. If LinkedIn also issues a refresh token, set it with the app's client id and secret and the Hub
   renews the access token by itself. Otherwise, renew the token before it expires; the Hub warns once a day when LinkedIn refuses it.
6. **Set the Hub variables** on Railway:
   - required: `HUB_LINKEDIN_ACCESS_TOKEN` and `HUB_LINKEDIN_ORGANIZATION_ID` (the Page's numeric id);
   - optional: `HUB_LINKEDIN_AD_ACCOUNT_ID`, `HUB_LINKEDIN_REFRESH_TOKEN`, `HUB_LINKEDIN_CLIENT_ID`, `HUB_LINKEDIN_CLIENT_SECRET`, the
     `HUB_LINKEDIN_ADS_*` variables of a second app, and `HUB_LINKEDIN_API_VERSION` (default `202609`; set a newer YYYYMM when
     LinkedIn retires it).
7. **Restart the Hub**, then press **Run now** on "Weekly social report" to check the connection. The same hand-over steps cover
   LinkedIn: "Social posts", "Social replies" (except deletions, which always wait for you) and "Ad tuning". A LinkedIn budget change,
   like Meta's, only ever happens on your own approval and under your cap.

## Verification

- `npm test -- server/agents/social` runs the unit tests. They cover the Meta client against a fake Graph API, the LinkedIn client
  against a fake REST API (headers, escaping, token renewal, image upload, ads), the ad rules, the checks and prompts, every task and
  every executor on both platforms.
- `node server/agents-social-integration.mjs` (with `HUB_TEST_DATABASE_URL` on a local Supabase) checks the database rules through the
  real server role: post holds, open targets, the budget refusal and agent ownership.
- `supabase/tests/073_social_manager.test.sql` checks the seed, the schedules, the hand-over steps and the boundaries.

None of this was run against a live Meta or LinkedIn account. Connect a Page first and watch the first week in Propose before handing
anything over.
