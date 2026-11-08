# Social media: the Social Media Manager

The Social Media Manager runs CareMetric's **Facebook Page**, **Instagram professional account** and **Meta ad account** for
engagement. It plans and drafts posts, answers comments and messages, writes ad copy, evaluates every ad every day and changes what is
not working. Every post, reply and ad change waits for the owner's approval until the owner hands that kind of work over. A budget
increase always waits. It starts **paused, in Propose** (`20261108190000_social_manager.sql`, gate `20261108190100_social_manager_contract.sql`,
feature `platform.agents.social.v1`), with a daily model budget of $4.00 on the Draft tier.

LinkedIn has no connection: its API needs LinkedIn's partner approval. The weekly plan writes LinkedIn posts and emails them to the
owner, ready to paste.

## What it does

| Work (task) | When | What happens |
| --- | --- | --- |
| Weekly social plan (`social.plan`) | Each morning at 08:15 Eastern; plans once a week | Drafts 3 Facebook, 2 Instagram and 3 LinkedIn posts. It works from the fact sheet, the sales playbook and the last four weeks' engagement (more like what worked, never a repeat). Each draft is checked. Facebook and Instagram posts are proposed with a time slot (10:30 Eastern for Facebook, 12:15 for Instagram); an approved post is held until then and published. The owner gets the plan by email with the LinkedIn posts. |
| Comments and messages (`social.inbox`, `social.interaction`) | Every 15 minutes | Finds new comments on the Page's and Instagram's recent posts and new Messenger messages. Each gets its own task. With `HUB_AGENTS_CUSTOMER_TEXT_TO_AI=true` it drafts a short, checked reply for approval, or proposes hiding spam. Without it, the owner is told and answers on Meta. |
| Daily ad review (`social.ads`) | Each morning at 09:10 Eastern | Judges every ad on the last seven days against the seven before, with the rules below. It proposes pausing losers and new copy where an ad set needs it, plus a budget increase only under the owner's cap. |
| Weekly social report (`social.report`) | Each morning at 08:05 Eastern; sends once a week | Shows posts and engagement per platform, the top posts, and ad spend, impressions, click rate, results and cost per result per ad set. It also counts what is waiting for the owner. |

Instagram posts need an image. They use the brand images in `HUB_SOCIAL_IMAGE_URLS` in turn; with none, the plan leaves Instagram out.
New ad copy reuses the image of the ad set's best ad.

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

Results are leads and sign-ups as Meta reports them. A new ad runs inside the ad set's existing budget, so pausing and adding ads never
raises spend.

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
- links only to that product's own pages, none in an Instagram caption or in ad text;
- at most five hashtags (eight on Instagram) and three emoji;
- only that product's prices;
- no promise of a refund, extension or special pricing;
- no claim about a person's personal attributes in an ad (Meta's advertising policy);
- no mention of AI;
- in a reply, nothing repeated from the person's message.

A draft that fails is dropped. The run records only the check's name.

## Privacy

- Comments and messages are read from Meta when they are handled and never stored in the Hub: no task, run, action or owner email holds
  another person's words.
- A public comment that appears to carry personal or health information is proposed for hiding, and the owner is warned, before any model
  sees it.
- Replies never discuss anyone's account, health or personal details in public; they invite a private message or support@caremetric.ai.
- Meta's 24-hour rule applies to messages: a message older than that is left for the owner.
- The token goes only to graph.facebook.com and is never shown or logged.

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

A request Meta may have received but did not confirm is never retried. It fails as `social_unconfirmed` and the owner is asked to look
at the Page or Ads Manager first. A token Meta refuses (expired or missing a permission) is reported to the owner once a day.

## Verification

- `npm test -- server/agents/social` runs the unit tests. They cover the Meta client against a fake Graph API, the ad rules, the checks
  and prompts, every task and every executor.
- `node server/agents-social-integration.mjs` (with `HUB_TEST_DATABASE_URL` on a local Supabase) checks the database rules through the
  real server role: post holds, open targets, the budget refusal and agent ownership.
- `supabase/tests/073_social_manager.test.sql` checks the seed, the schedules, the hand-over steps and the boundaries.

None of this was run against a live Meta account. Connect a Page first and watch the first week in Propose before handing anything
over.
