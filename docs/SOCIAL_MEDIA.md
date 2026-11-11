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
| Comments and messages (`social.inbox`, `social.interaction`) | Every 15 minutes | Finds new comments on the Facebook Page's, Instagram's and the LinkedIn Page's recent posts, and new Messenger messages. Each gets its own task. With Settings → AI team → "Let agents send customer messages to the AI" on, it drafts a short, checked reply for approval, or proposes hiding spam (deleting it on LinkedIn). Without it, the owner is told and answers on the platform. |
| Daily ad review (`social.ads`) | Each morning at 09:10 Eastern | Judges every Meta ad and LinkedIn creative on the last seven days against the seven before, with the rules below. It proposes pausing losers and new copy where an ad set needs it, plus a budget increase only under the owner's cap. |
| Weekly social report (`social.report`) | Each morning at 08:05 Eastern; sends once a week | Shows posts and engagement per platform, the top posts, and ad spend, impressions, click rate, results and cost per result per ad set. It also counts what is waiting for the owner. While the [Monday scorecard](MONDAY_SCORECARD.md) carries it ("Send the individual weekly reports" off), its scheduled run sends nothing; Run now still emails it. |

Instagram posts need an approved image or an approved vertical video. Images come first from the Creative Director, then from
Settings → Social media → "Approved brand images"; with neither compatible images nor videos, the plan leaves Instagram out.
LinkedIn image posts use the same fallback images as the thumbnail of their link card: LinkedIn builds no preview for a post made
through its API, so the image is uploaded with the post. New ad copy reuses approved creative images or the image of the ad set's
(or LinkedIn campaign's) best ad.

## Approved video posts

The weekly plan selects approved MP4 creative for the same product and platform when video publication is installed. Facebook accepts
the Creative Director's square, portrait and vertical Meta video placements; Instagram uses only vertical video as a Reel; LinkedIn
accepts its square, portrait and vertical placements. Each video appears in the post approval preview. Facebook and LinkedIn captions
include the checked product link; Instagram captions retain the existing no-link rule. Paid video ads and YouTube uploads remain manual.

Apply `20261111031736_social_video_publication.sql` and `20261111031738_social_video_publication_contract.sql`, then restart the Hub.
Without that feature, the existing image and link posts continue. A public HTTPS Hub origin is required: publishers accept only the
Hub's own approved creative URL, and the database checks that the selected asset is still approved or live before each stage.
No arbitrary video URL can be uploaded by a post action. LinkedIn uploads are limited to 60 MiB; the Creative Director also checks
the asset's platform limits before approval.

Facebook uploads the video unpublished, checks its processing status, then publishes it. Instagram creates a Reels container, waits
for `FINISHED`, then publishes that container. LinkedIn initializes and finalizes an upload, waits for `AVAILABLE`, then creates the
Page post. The worker persists the provider ID and stage, checks again on later runs while processing, and gives up after one hour.
The same post approval and schedule cover the whole sequence. Nothing changes the owner's existing approval or budget controls.

If a write may have succeeded but the platform did not confirm it, or the worker stopped before recording confirmation, the action
stops as `social_unconfirmed`. Inspect the Page and the provider's uploaded videos first. The saved upload/publication intent prevents
an automatic repeat, including after a worker restart. Confirmed processing failure or timeout needs a fresh reviewed proposal.

Video uses the existing Meta `pages_manage_posts` / `instagram_content_publish` permissions and LinkedIn's `w_organization_social`
permission with approved Community Management API access. These permissions and the account's app review must be granted by the
platform; connecting a token does not grant them. The implementation follows Meta's
[Instagram publishing collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api), Facebook's
[Video API fields](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/advideo.py), and
LinkedIn's [Videos API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-09)
and [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-09).

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
  the owner's cap, Settings → Social media → "Most any ad may spend per day". With no cap set, no increase is ever proposed.
  The executor re-checks the cap, refuses a step over 25%, and refuses if the budget changed since the proposal. The database refuses any automatic approval of a budget change.

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

- a length per surface;
- no markup;
- links only to that product's own pages, none in an Instagram caption or in ad text; a page with well-formed campaign tags counts as
  that page, and a tag carrying anything else fails (see "Campaign tags on product links" in [AI_TEAM.md](AI_TEAM.md));
- at most five hashtags (eight on Instagram) and three emoji;
- only that product's prices;
- no offer of a demo, a call, a meeting or a conversation (CareMetric does no personal demos with anyone; see "No demos, calls or
  meetings" in [AI_TEAM.md](AI_TEAM.md#no-demos-calls-or-meetings));
- no promise of a refund, extension or special pricing;
- no claim about a person's personal attributes in an ad (Meta's advertising policy);
- no mention of AI;
- in a reply, nothing repeated from the person's message.

A draft that fails is dropped. The run records only the check's name.

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
- The Meta token goes only to graph.facebook.com or graph-video.facebook.com; the LinkedIn tokens go only to api.linkedin.com, to www.linkedin.com to renew them,
  and to the upload address LinkedIn returns on an allowed LinkedIn host. No token is ever shown or logged. Brand images and source videos are fetched
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
3. **Set the token and the account ids.**
   - On Railway, the secret: `HUB_META_ACCESS_TOKEN` (required). The Control center's integration panel shows whether it is set.
   - In the Hub, under Settings → Social media: "Facebook Page id" (required), and optionally "Instagram account id", "Meta ad
     account id", "Approved brand images" (one https address per line, at most 20), "Target cost per lead or sign-up" and "Most any
     ad may spend per day" (both in dollars).

   To draft replies, Settings → AI team → "Let agents send customer messages to the AI" must be on and the Anthropic key set too.
   The ids, images and ad limits used to be Railway variables (`HUB_META_PAGE_ID` and the others); the Hub copies them into Settings
   once on its first start after the settings migration, and they can then be deleted. [Settings](SETTINGS.md) lists every setting.
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
   app, its token goes in `HUB_LINKEDIN_ADS_ACCESS_TOKEN` on Railway (and its refresh token and client secret in
   `HUB_LINKEDIN_ADS_REFRESH_TOKEN` and `HUB_LINKEDIN_ADS_CLIENT_SECRET`), and its client id in Settings → Social media →
   "LinkedIn advertising app client id".
5. **Generate the tokens** (OAuth 2.0 authorization code flow, or the developer portal's token generator), signed in as the Page's admin:
   - Page app: `r_organization_social`, `w_organization_social` and `rw_organization_admin`, plus any comment scopes LinkedIn adds to
     the product (such as `r_organization_social_feed` and `w_organization_social_feed`);
   - ads app: `r_ads`, `rw_ads`, `r_ads_reporting`, `r_organization_social` and `w_organization_social` (sponsored-only posts carry each
     new ad's copy).

   An access token lasts 60 days. If LinkedIn also issues a refresh token, set it with the app's client id and secret and the Hub
   renews the access token by itself. Otherwise, renew the token before it expires; the Hub warns once a day when LinkedIn refuses it.
6. **Set the tokens and the ids.**
   - On Railway, the secrets: `HUB_LINKEDIN_ACCESS_TOKEN` (required), and optionally `HUB_LINKEDIN_REFRESH_TOKEN`,
     `HUB_LINKEDIN_CLIENT_SECRET` and a second app's `HUB_LINKEDIN_ADS_ACCESS_TOKEN`, `HUB_LINKEDIN_ADS_REFRESH_TOKEN` and
     `HUB_LINKEDIN_ADS_CLIENT_SECRET`.
   - In the Hub, under Settings → Social media: "LinkedIn Company Page id" (required; the Page's numeric id), and optionally
     "LinkedIn ad account id", "LinkedIn app client id" (needed with the refresh token and client secret), "LinkedIn advertising
     app client id" (a second app only) and "LinkedIn API version" (default `202609`; enter a newer YYYYMM when LinkedIn retires it).
7. **Restart the Hub**, then press **Run now** on "Weekly social report" to check the connection. The same hand-over steps cover
   LinkedIn: "Social posts", "Social replies" (except deletions, which always wait for you) and "Ad tuning". A LinkedIn budget change,
   like Meta's, only ever happens on your own approval and under your cap.

## Verification

- `npm test -- server/agents/social` runs the unit tests. They cover the Meta client against a fake Graph API, the LinkedIn client
  against a fake REST API (headers, escaping, token renewal, image/video upload, ads), the ad rules, the checks and prompts, every task and
  every executor on both platforms, plus persisted video processing, restarts and uncertain-send handling.
- `node server/agents-social-integration.mjs` (with `HUB_TEST_DATABASE_URL` on a local Supabase) checks the database rules through the
  real server role: post holds, open targets, the budget refusal, agent ownership and fenced video stages, including asset retirement.
- `supabase/tests/073_social_manager.test.sql` checks the seed, the schedules, the hand-over steps and the boundaries.
- `supabase/tests/079_social_video.test.sql` checks the video feature and its database privileges.

None of this was run against a live Meta or LinkedIn account. Connect a Page first and watch the first week in Propose before handing
anything over.

## Campaign tags

Every product link the Social Media Manager places carries campaign tags (`server/agents/links.mjs`), so the weekly growth report can
count the leads it brings: a post's link and a link in a reply get utm_source `facebook`, `instagram` or `linkedin` (a Messenger reply
counts as `facebook`), utm_medium `social`, utm_campaign `social-<product>` and utm_content `post` or `reply`; a new ad's link gets
utm_medium `paid_social` and utm_content `ad`, with utm_source `facebook` for a Meta ad (it may also run on Instagram) or `linkedin`.
A new ad based on an ad whose link already carries tags keeps that page and gets these tags instead. Before it publishes a post the
executor checks its link again: only a product page, as written or with well-formed tags.
