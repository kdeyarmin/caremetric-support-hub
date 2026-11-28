# State launches

You choose the next state on **Growth → State launches**. The Marketing Manager builds that state's cold email in Instantly the
way Pennsylvania was built by hand on November 27 and 28, 2026. It finds the facilities, a decision-maker and a checked address at
each, your five campaigns with your copy, and the do-not-contact checks. When it is ready you are told, and nothing is sent until
you click **Launch**.

This was your decision on November 28, 2026: "I'd prefer this to be fully automated so that I can just choose the next state and
all of this is automatically done". Your choices were:

- Instantly sends every state.
- The Hub builds the lists and campaigns.
- Replies and opt-outs come back to the Hub's do-not-contact list.
- Pennsylvania is Instantly's too.
- Nothing goes out until you click Launch.

## Before the first state

1. In Railway, paste an Instantly API key into `INSTANTLY_API_KEY`. Create the key in Instantly under Settings → Integrations →
   API keys, with all scopes. `HUNTER_API_KEY`, `HUB_INTEL_FEED_SECRET` and `HUB_GROWTH_SIGNING_KEY` are already set.
2. In **Settings → Customer growth**, turn on **Build state launches in Instantly**.
3. **Instantly mailboxes for state launches** already lists the four Google mailboxes bought on November 28. The Airmail Rocket
   inbox is left out, as it was for Pennsylvania. Keep them warming in Instantly.

Growth → State launches lists anything still missing.

## What happens after you choose a state

The Marketing Manager's `outreach.launch` task runs every five minutes. Each run takes the oldest open launch one step further:

1. **Gathering.** It collects:
   - every nursing home in the state, from CMS's Provider Data Catalog (dataset `4pq5-n9py`), with its chain and how many
     buildings the chain has;
   - every home health agency and hospice, from Intel's marketing feed;
   - the state's counties.
2. **Finding people.** It looks for a decision-maker and a checked work address at each facility (see "Finding the people"). It
   goes in this order:
   1. chains and groups;
   2. your local nursing homes;
   3. everyone else, smaller first.

   It stops when every facility is looked up or the state's Hunter searches are used.
3. **Building the campaigns.** It checks every person again against the do-not-contact list, keeping one person per address and
   one per business domain. It then creates one draft campaign per segment in Instantly, with your copy word for word and the
   people as leads. You get an email saying the state is ready, with the count in each campaign.
4. **Launch.** Click **Launch** on the state, and the next run starts each campaign in Instantly. Emails go out on weekdays from
   8:00 to 16:00 in the state's time zone, ten minutes apart, at most **Most emails a day from each Instantly mailbox** per
   mailbox. A lead stops at its first reply.

A large state takes a few hours to build. **Cancel** stops a launch before it sends. Campaigns it already made stay in Instantly
as drafts.

## Who gets which email

These are the rules Pennsylvania was built with (`server/outreach/segment.mjs`).

| Facility | Campaign |
| --- | --- |
| Nursing home in **Your local counties** (default: Cambria and the seven around it) | Local nursing homes (signed without "Dr.") |
| Nursing home in a chain of 20 or more buildings | Chains – corporate: one email to the chain's head office (its largest building's administrator when the head office has nobody to write to) |
| Nursing home in a group of 2 to 19 buildings | Regional groups – leadership: one email to the group |
| Any other nursing home | Skilled nursing administrators |
| Home health agency or hospice | Home health & hospice owners |

These are left out:

- a nursing home in a hospital;
- any facility run by a government;
- the other buildings of a chain or group;
- an agency in Cambria County, your home county;
- a national home health or hospice chain (Bayada, Amedisys, Gentiva and the like);
- the second agency of a business with two (a home health agency and its hospice).

The copy is `server/outreach/copy.mjs`. It is Pennsylvania's five sequences, and only each link's `utm_campaign` names the
state (`oh-snf`, `oh-starter`). A test checks that Pennsylvania's copy equals the campaigns built by hand. It also checks that
no email has a telephone number or a discount as a number.

## Finding the people

This is `server/outreach/people.mjs`.

1. **Domain Search.** Hunter is asked by the facility's name, or by a chain's or group's name for its corporate email. It answers
   the business's domain and up to ten senior people there with their addresses.
2. **Domain check.** The domain is kept only if it is the business's own: an operator's site carrying most of the facility's
   name, never a directory, a page builder or a government site.
3. **Choosing the person.**
   - At a facility: the owner, the CEO or president, the administrator, the executive director, or the director of admissions,
     marketing or business development.
   - At a head office: the officer for marketing, sales, business development or admissions first, then operations, then the
     CEO.
4. **Email Finder fallback.** When the domain is right but nobody there decides, one Email Finder search is tried for a name CMS
   lists: an agency's individual owner, or the official the NPI registry lists for the facility.
5. **Checking the address.** An address is kept only if all of these hold:
   - it is on the business's own domain;
   - Hunter's check calls it valid with a score of 80 or more, or, on a domain that accepts every address, Hunter saw it
     published with a score of 90 or more.

   An address is never guessed.

Hunter charges a search credit only when it returns an address. A facility usually costs one search, two at most, and a chain
up to four. **Most Hunter searches for one state** (default 400) caps a launch. Chains, groups and your local nursing homes come
first, then smaller facilities.

When the searches run out, the launch is still built from the people found. Choose **Find more people** once Hunter is topped
up. It looks up the rest and adds them to the same campaigns. On November 28, Hunter had about 800 searches left until it resets, and a
large state has 2,000 facilities or more. A big state needs more searches than that, or a larger Hunter plan.

## Replies and opt-outs

Instantly reports every campaign in the workspace to the Hub, Pennsylvania's built by hand included. The address is
`/api/growth/instantly`. It carries a key made from `HUB_GROWTH_SIGNING_KEY`, so it needs no secret of its own. The Hub
subscribes the webhook itself once `INSTANTLY_API_KEY` is set (`server/outreach/webhook.mjs`).

| Instantly reports | The Hub |
| --- | --- |
| "no thanks", "not interested", "remove me", an unsubscribe, or a lead Instantly marks not interested | Puts the address, its business's own domain and the facility on the do-not-contact list for good. That list also covers your own sequences and the Marketing Manager's cold email. |
| A bounce | Marks the facility bounced. Instantly stops the lead. |
| "yes" to a state launch's email | Intel emails the free county report for the lead's county, once, and you are told. |
| Any other reply to a state launch, or a lead marked interested | You are told, with the reply, to answer in Instantly's Unibox. |
| An automatic reply (out of office, has left) | Nothing. Instantly keeps or stops the lead itself. |

Pennsylvania's hand-built campaigns keep their own Instantly workflows for the county report. Their opt-outs still reach the
do-not-contact list.

## Pennsylvania

**States Instantly sends to** is Pennsylvania by default. While it lists Pennsylvania:

- your weekly sequence batches stop (Settings → Customer growth → Build your next sequence batch), so an agency never gets both;
- Hunter's owner lookups for those batches stop too, keeping the searches for state launches.

Batch 1's emails (December 1, 4 and 9) still go out as approved.

## For developers

| Part | Where |
| --- | --- |
| Migration and contract | `20261128100000_state_launches.sql` adds the settings, `private.state_launches`, `private.state_launch_targets`, the Hub server's functions and the owner's commands. `20261128100100_state_launches_contract.sql` declares `platform.agents.state-launches.v1`. |
| Server | `server/outreach/`: `launch.mjs` runs each stage and handles the webhook. The other modules are `cms.mjs`, `segment.mjs`, `people.mjs`, `instantly.mjs`, `copy.mjs`, `webhook.mjs` and `store.mjs`. |
| Owner commands | The growth service's `launches`, `launch`, `launchRequest`, `launchApprove`, `launchMore` and `launchCancel` operations. |
| Page | `src/admin/StateLaunches.tsx`, the panel on Growth. |
