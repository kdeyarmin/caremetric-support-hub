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
| Weekly social plan (`social.plan`) | Each morning at 08:15 Eastern; plans once a week | Drafts 4 Facebook, 3 Instagram and 4 LinkedIn posts. It works from the fact sheet, the sales playbook and the last four weeks' engagement (more like what worked, never a repeat). Each draft is checked. Each post is proposed with a time slot (10:30 Eastern for Facebook, 12:15 for Instagram, 8:45 for LinkedIn); an approved post is held until then and published. The owner gets the plan by email, with the LinkedIn posts to paste while LinkedIn is not connected. |
| Comments and messages (`social.inbox`, `social.interaction`) | Every 15 minutes | Finds new comments on the Facebook Page's, Instagram's and the LinkedIn Page's recent posts, and new Messenger messages. Each gets its own task. With Settings → AI team → "Let agents send customer messages to the AI" on, it drafts a short, checked reply for approval, or proposes hiding spam (deleting it on LinkedIn). Without it, the owner is told and answers on the platform. |
| Daily ad review (`social.ads`) | Each morning at 09:10 Eastern | Judges every Meta ad and LinkedIn creative on the last seven days against the seven before, with the rules below. It proposes pausing losers and new copy where an ad set needs it, plus a budget increase only under the owner's cap. The review finishes once it has proposed, so an undecided proposal (a budget change always waits for you) never holds back the next morning's review. LinkedIn ads are checked against LinkedIn's headline and description lengths (70 characters), Meta ads against Meta's (40 and 30). |
| Weekly social report (`social.report`) | Each morning at 08:05 Eastern; sends once a week | Shows posts and engagement per platform, the top posts, and ad spend, impressions, click rate, results and cost per result per ad set. It also counts what is waiting for the owner. While the [Monday scorecard](MONDAY_SCORECARD.md) carries it ("Send the individual weekly reports" off), its scheduled run sends nothing; Run now still emails it. |

Instagram posts need an approved image or an approved vertical video. Images come first from the Creative Director, then from
Settings → Social media → "Approved brand images"; with neither compatible images nor videos, the plan leaves Instagram out.
LinkedIn image posts use the same fallback images as the thumbnail of their link card: LinkedIn builds no preview for a post made
through its API, so the image is uploaded with the post. New ad copy reuses approved creative images or the image of the ad set's
(or LinkedIn campaign's) best ad.

## Events, stories, articles, your own profile and new campaigns (2026-11-13)

- **Event posts** (Settings → Social media → Post about new CMS data and observances): the weekly plan sees the releases Intel loaded in
  the last two weeks and the healthcare observances starting in the next three, and may write one post a week about one of them (the
  `data` pillar). It states no statistic.
- **Article links**: a post may link to an article the team published in the last 45 days (its canonical address on Intel's site or in
  the help center), checked like a product page.
- **Stories**: up to two approved 1080×1920 story images a week are proposed for Instagram (first) or the Facebook Page, each its own
  post to approve, with no text or link. Instagram publishes a STORIES container; the Page uploads the photo unpublished and posts it
  as a photo story. A story shows for 24 hours.
- **Your own LinkedIn profile** (Settings → Social media → Write posts for my LinkedIn profile): a few posts a week in your voice, each
  a `social.founder_post` you approve one by one, until you hand them over (below). With your personal token on the LinkedIn
  card (scopes `openid`, `profile`, `w_member_social`) an approved post publishes as you, at its time slot like a Page post (an
  approved post waits for its slot, and one started early is handed back to wait); without it the drafts are emailed to copy.
  Nothing sends messages, connection requests or comments.
- **New campaigns and lead reports**: see Settings → Paid ads and [AI_WORKFORCE_REVIEW_2026-11-13.md](AI_WORKFORCE_REVIEW_2026-11-13.md).

### Founder posts on their own (2026-11-15)

The owner chose to stop approving his own profile's posts one by one. The autonomy step **Founder posts** (`founder_posts`, AI team
page; it ships held, see [Four more hand-overs](AI_TEAM.md#four-more-hand-overs-owner-decision-2026-11-15)) adds `social.founder_post`
to the Social Media Manager's list. While it is automatic:

- Each post that passes the fact-sheet checks is approved by the database on its own and published through the same executor at its
  time slot; the proposal says "on its own (you handed founder posts over)". One started early is handed back and keeps its automatic
  approval.
- Just before it publishes, the executor checks the hand-over again (`private.agent_action_trusted`): the Social Media Manager still
  active, on Act and trusted with founder posts, and the step still automatic. A pause, a lower level or **Keep approving** stops any
  post already queued, which then fails as "approval required".
- Without your personal LinkedIn token the posts are still emailed for you to copy, as before.
- While the step is held, the database still refuses an automatic approval of a founder post (`agent_actions_handover_guard`).

### New campaigns launched on their own (2026-11-15)

Once a month per marketed product, `ads.plan` proposes a LinkedIn campaign, a Meta retargeting campaign and a Google search campaign
(`server/agents/ads/index.mjs`). Each waits for your approval and is created paused (LinkedIn as a draft) with no ads, and you add the
first ad in the platform's ad manager. Since 2026-11-16 Intel's campaigns send people to the free market report for their own agency
(`/market-review`: its share and rank in its county, the county's largest agencies and three moves, emailed as a PDF), not the county
report; the report is for home health agencies and hospices, so the LinkedIn proposal says to use the Medicare roster's company list as
the campaign's audience.

**Budget flights (2026-11-16).** A thirtieth of a small monthly number a day is below every platform's least daily budget here
(LinkedIn $10, Meta and Google $5), so at $50 a month no campaign could run. With **Settings → Paid ads → Run each month's campaign as a
short flight** set (3 to 30 days; empty is off), the month's number funds one campaign instead (`flightBudget` in
`server/agents/ads/index.mjs`):

- It runs at the number divided by those days a day, never below the platform's least (so fewer days when the number is small) nor
  above the daily ad-set limit, and never past the month. At $50 and 10 days: Meta $5 a day for 10 days, or LinkedIn $10 a day for 5.
- The plan proposes one campaign a month: the first that can carry the flight in its usual order (LinkedIn, Meta, Google search),
  one that would start on its own with approved creative first when you handed launch over. None in a month whose flight is taken,
  so the number is never spent twice. The month's campaigns are read on every platform and product, connected or not
  (`private.ads_month_campaigns`): one that was created takes the flight whatever its pacing (a LinkedIn flight made before LinkedIn was
  disconnected still counts), and so does a flight still waiting, approved or one you turned down. A proposal that failed or expired,
  or one paced over the whole month that was never created, leaves the flight free, so a flight can take its place.
- It is created with its last day, so it ends on its own: started later than the day you approve it, it runs fewer days, never more.
  Handed over, it reserves only its own days of the month's number (`private.ads_launch_reserve`).
- A Google flight needs the Google Ads API (an import file cannot carry its last day).
- A campaign approved before flights were switched on or off is refused when it is created (`budget_changed`), so it is planned again
  under the setting as it stands. The autonomy step **Ad campaign launch** (`ad_campaigns`, AI team page; it ships held) adds
`social.campaign_create` and `social.google_campaign` to the Social Media Manager's list. While it is automatic:

- **The first ad comes from creative you already approved.** The plan picks, for each LinkedIn or Meta campaign, the first approved
  Creative Director image for that product and platform whose words pass that platform's ad checks (the same rule the daily ad review
  uses, `adCopyFromCreative`), and shows it in the proposal. At launch the campaign is created paused (a draft on LinkedIn), the ad is
  put in through the daily ad review's own `social.ad_create` path (its checks, and marking the creative live), and only then is the
  campaign started (the ad set, then the campaign on Meta; the group, then the campaign on LinkedIn). A Google search campaign starts
  with the responsive search ad the plan wrote and code checked against the fact sheet.
- **Spending stays within your numbers.** The campaigns starting on their own share "Most to spend on new campaigns a month": each
  gets a thirtieth of its share a day, never above "Most any ad may spend per day". Before it is created, each reserves its daily budget
  for the rest of the month in the database (`private.ads_launch_reserve`, table `private.ads_launch_reservations`, closed to every
  role), lowered to what the month's number has left; every campaign launched this way ends on the month's last day. No budget is ever
  raised: an ad set's budget increase still waits for you.
- **Where launching live is not possible, it falls back to the way before**, and you are told why: no approved creative that fits, the
  creative no longer approved, too little of the month's number left, the month's last day, or (for Google) the Google Ads API not set
  up, in which case the campaign is emailed as a Google Ads Editor file, paused. If Google refuses to create it running, it is created
  paused. If the first ad is refused, the campaign stays paused and its share is given back. If starting it is not confirmed, you are
  asked to look; its budget and end date bound it either way.
- **Checked again when carried out**: as for founder posts, a campaign approved automatically goes ahead only while the hand-over
  still stands, and an owner's approval of a campaign still creates it paused.

## Approved video posts

The weekly plan selects approved MP4 creative for the same product and platform when video publication is installed. Facebook accepts
the Creative Director's square, portrait and vertical Meta video placements; Instagram uses only vertical video as a Reel; LinkedIn
accepts its square, portrait and vertical placements. The owner's own finished videos (Creative → Add a finished video) are approved
creative too, and add 16:9 for Facebook and LinkedIn (`meta.video_landscape`, `linkedin.video_landscape`); Instagram never gets a 16:9 video.
Each video appears in the post approval preview. Facebook and LinkedIn captions include the checked product link; Instagram captions retain
the existing no-link rule. Paid video ads and YouTube uploads remain manual.

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

Open **Settings → Social media**. Each provider has a five-step guide with Previous/Next controls, exact permission names,
copyable addresses and a shortcut to the connection fields. The guide is instructions, not an authorization flow: advancing a
step never saves a credential or proves that a provider step succeeded. Open provider sites in your normal browser, especially
if an embedded window shows a login error. The sign-in help explains accessibility options for human verification; the Hub
cannot complete those checks.

A **Page ID** identifies the business Page. An **access token** is the secret code issued for the app's approved access. Neither
is a login email or password. Email-shaped Page IDs are rejected before saving, both in the browser and on the server. Autofill
hints discourage password managers but cannot guarantee they will comply.

A blank token retains the saved value; the explicit removal checkbox clears it. Tokens are encrypted and never returned to the
browser. **Access token saved · connection not checked** reports storage only. **Read access verified** appears after a successful
check and clears on edits. Checks read Page posts and any configured Instagram/ad account, without publishing or proving write
permissions. Authentication rejection can mean invalid, expired or revoked; the Hub does not infer which from a generic response.
Saved changes apply to agents within a minute without a restart. Signing in to Meta or LinkedIn alone does not connect the Hub.

## Connecting Meta

The guide uses a **system user access token** for assets in your own business portfolio.

1. In **Meta Business Suite → Settings → Accounts → Pages**, select the correct portfolio and Page; copy the Page ID.
2. In [Meta's app dashboard](https://developers.facebook.com/apps/), create or select the app associated with that portfolio.
   The Pages use case is **Manage everything on your Page**. Complete the permission, review and verification requirements Meta
   displays; system-user access is not available to every business.
3. In **Business Suite → Settings → Users → System users**, create a regular/employee system user and assign both the Page's
   required tasks and the app. Do not use an admin system user for routine asset access. App and system user must belong to the
   same portfolio.
4. Choose **Generate new token**, select the app, expiration and permissions, then **Generate token**. Page posts/comments need
   `business_management`, `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_posts` and
   `pages_manage_engagement`. Add `pages_messaging` for Messenger. Missing choices require resolving app assignment or permission
   access first. Note the expiry; the Hub does not automatically renew Meta tokens.
5. Enter **Facebook Page ID** and **Meta system user access token** in the Hub and choose **Save and check**. Start with optional
   accounts blank. A numeric Page ID or a Page's `https://www.facebook.com/profile.php?id=…` address is accepted, not a personal
   profile or a vanity-name Page URL.

**Optional: add Instagram** explains linking a professional account to the Page, assigning it to the system user, and requesting
`instagram_basic`, `instagram_content_publish` and `instagram_manage_comments`. In Meta's Graph API Explorer, a GET of
`YOUR_PAGE_ID?fields=instagram_business_account` returns the linked account's numeric `id`. Enter that under **Instagram
professional account ID**, not an @username. This integration uses Instagram through Facebook Login, not Instagram Login.

**Optional: add Meta advertising** requires assigning the ad account and adding `ads_read` and `ads_management` to the token.
Enter **Meta ad account ID**. Configure **Target cost per lead or sign-up** and **Most any ad may spend per day** separately.

Official sources checked November 11, 2026: [Pages app setup](https://developers.facebook.com/documentation/pages-api/create-an-app),
[system user setup](https://www.facebook.com/business/help/503306463479099),
[system user requirements](https://developers.facebook.com/docs/business-management-apis/system-users/overview),
[token permissions and expiry](https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens).
Provider menus and eligibility can vary; these sources describe the public requirements, not the owner's current app approval.

## Connecting LinkedIn

1. Sign in to LinkedIn in your normal browser, then open [the developer site](https://developer.linkedin.com/) in that browser
   and choose **My apps**.
2. Select the app for your Company Page, or **Create app** with the Page, app name, logo and published privacy policy. In the app's
   **Settings → Verify → Generate URL**, create the verification address and have the Page super admin approve its association.
3. In **Products → Community Management API → Request access**, submit the business details and wait for approval. This requires
   a business email and legal organization information. Sign In with LinkedIn or Share on LinkedIn alone is insufficient. If
   another product blocks the application, LinkedIn directs applicants to use a new Community Management app. Development tier
   allows testing, but the Hub's engagement reporting uses batch requests excluded from that tier: Standard approval is needed
   for the full workflow.
4. Open the separate [OAuth Token Tools](https://www.linkedin.com/developers/tools/oauth), select the approved app and **3-legged
   OAuth**, and authorize as the Page administrator. Request `r_organization_social`, `w_organization_social`,
   `r_organization_social_feed` and `w_organization_social_feed` for posts/comments. Choose **Copy token** and note its expiry.
   Missing permissions mean app access still needs attention. This tool is not an app's Tools tab.
5. Copy the number from the Page's admin address into **LinkedIn Company Page ID**, and the generated value into **LinkedIn access
   token**. Choose **Save and check**. Numeric IDs, `urn:li:organization:…` and numeric `/company/123456/admin/` addresses work;
   vanity-name URLs do not. A saved number alone does not verify which Page it belongs to.

**Optional: renew LinkedIn tokens automatically** needs a refresh token issued by LinkedIn plus the same app's client ID and
secret from **Auth**. Eligibility is controlled by LinkedIn; an app secret alone does not enable renewal. Otherwise replace the
access token before its stated expiry.

**Optional: add LinkedIn advertising** needs Advertising API approval and Campaign Manager account access. Development apps must
also list the ad account under **Products → Advertising API → View settings**. Use `r_ads`, `rw_ads`, `r_ads_reporting`,
`r_organization_social` and `w_organization_social` for the Hub's ad workflow. A separate app can supply the advertising token and
renewal credentials. The **LinkedIn API version** setting remains below the cards (default `202609`).

Official sources checked November 11, 2026: [create an app](https://www.linkedin.com/help/linkedin/answer/a1667239),
[verify its Page association](https://www.linkedin.com/help/linkedin/answer/a1665329),
[Community Management approval and tiers](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-api-migration-guide),
[token generator](https://learn.microsoft.com/en-us/linkedin/shared/authentication/developer-portal-tools),
[permission list](https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access),
[ad account access](https://learn.microsoft.com/en-us/linkedin/marketing/getting-started).

## Start the Social Media Manager

Connecting accounts does not resume the agent or change its approval settings. Once access is ready, resume the Social Media
Manager on **AI team** in **Propose**, and use **Run now → Weekly social plan** to prepare drafts. Review posts, replies and ad
changes before handing work over under **Work the team does on its own**. **Keep approving** steps back and **Pause** stops the
agent. Budget increases always need approval and remain under your cap. LinkedIn comment deletions also always need approval.

To draft replies, **Settings → AI team → Let agents send customer messages to the AI** must be on and the Anthropic credential
configured. Set **Approved brand images** as needed. [Settings](SETTINGS.md) lists the other settings.

Requests the provider may have received but did not confirm are not retried; the owner must check the Page or ad manager first.
Refused tokens are reported to the owner once a day.

## Secure connection storage (deployment and recovery)

Apply `20261111060000_social_connections.sql` and `20261111060001_social_connections_contract.sql`. Provision
`HUB_SOCIAL_CREDENTIALS_KEY` on the Hub service as **64 hexadecimal characters generated from 32 random bytes** before releasing the
server. This is an encryption secret, not a user-facing setting. The owner must have a current Hub command session to save or check.
Provider credentials use AES-256-GCM with a fresh nonce and provider-specific authenticated data. The private table holds ciphertext
only, has RLS without policies and no direct role grants; its functions are restricted to the application server. Audit events contain
provider/key names, never tokens or ciphertext. Account IDs and versions remain ordinary Hub settings. Each form saves those IDs and
its encrypted bundle in one transaction with optimistic version checks.

Legacy social token variables remain a fallback **only until that provider’s first save in the Hub**. Afterward the encrypted bundle
is authoritative, including explicit removals; deleting an old Railway token cannot erase a saved credential. Integration setup and
the running agents use the same resolved credentials. Agents read account/client IDs and tokens from one database snapshot, so
independently refreshed general settings cannot temporarily pair a token with an older account. A failed database read or decryption disables provider credentials until a
successful refresh; it never restores an older Railway token. The refresh interval is 30 seconds.

Keep the encryption key in the service’s protected secret store and preserve it across deployments and database restores. Do not
replace it casually: a different key cannot decrypt existing bundles. Recovery requires restoring the original key. Planned rotation
requires a maintenance migration that decrypts with the old key and re-encrypts every bundle with the new key before switching all
service instances. There is no automatic key-rotation or recovery UI in this release. Database backups alone cannot recover tokens.

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

Just before a post, founder post or reply goes out, its words go through the writing check again, since a rule may have changed
since they were approved. Words that fail are not published, and the action fails with a code that names the check
(`post_check_long_sentence`, `post_check_trial_terms`, `reply_check_link`; `post_check_changed` when checking again would change
the approved words). The AI team page says in words which rule refused it (`writingCheckReasons` in `src/admin/teamProtocol.ts`),
so you can approve a corrected post. `invalid_post` is kept for a post the Hub cannot publish at all (its platform, a story's
image, or an image address that is not https).
