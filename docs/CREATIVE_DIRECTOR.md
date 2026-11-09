# The Creative Director

A member of the AI team that turns the marketing plans into finished, on-brand, compliant ad creative: static images and short videos for
Meta (Facebook and Instagram), LinkedIn, Google display and YouTube. It proposes every asset for the owner's approval, hands what the owner
approves to the Social Media Manager, and learns each week from how its creative performed.

It starts **paused, in Propose, trusted with nothing**, and does nothing until the owner switches it on (see "Switching it on"). Nothing it
does posts, publishes or spends: the Social Media Manager publishes, and only what the owner approved.

| Piece | Where |
| --- | --- |
| Data model, server and owner operations | `supabase/migrations/20261109200000_creative_director.sql`, gate `20261109200100_creative_director_contract.sql` (feature `platform.agents.creative.v1`) |
| Code | `server/agents/creative/` |
| Owner screen | **Creative** (`/admin/creative`), also linked from **AI team** |
| Tests | `npm test -- server/agents/creative src/admin/Creative.test.tsx`; `node server/agents-creative-integration.mjs` with `HUB_TEST_DATABASE_URL` on a local Supabase |

## What it does

```
marketing plan output ──► creative.plan ──► briefs ──► creative.request ──► drafts (checked copy)
owner's New brief  ───────────────────────────┘                                │
rejection note (revision) / winner (refresh) ─┘                                ▼
                                   creative.render (every 10 min, daily cap) ──► render ──► full compliance check
                                                                                   │            │
                                                                   blocked (never shown)   proposed ──► owner
                                                                                                         │
                                         approve ──► creative.asset executor ──► "approved" ──► Social Media Manager uses it
                                         reject with a note ──► revision brief ──► creative.request
```

Every task runs on Eastern time. Only products the owner markets (the **Products we market** switches on the AI team page) get creative;
CareBase is off while it is in its pilot.

| Task | When | What |
| --- | --- | --- |
| `creative.plan` | 08:30 every morning, and as soon as the Social Media Manager writes its weekly plan | Reads marketing plan output that has no creative yet (this week's proposed or published social posts, the Marketing Manager's approved content briefs), opens one brief per product and pillar, and queues a `creative.request` for each |
| `creative.request` | Per brief: the plan's, the owner's **New brief**, a winner's refresh, a rejection note's revision | Writes the concept and the final copy on the **quality** tier (Opus), then two to four more variants on the **draft** tier (Sonnet), each on a different hook, so a brief yields three to five variants; checks every word; stores one draft per variant and placement |
| `creative.render` | Every 10 minutes | Proposes rendered assets, collects finished HeyGen renders, renders drafts (at most `HUB_CREATIVE_DAILY_RENDER_CAP` a day, default 40, across every server), checks each finished asset in full and proposes it, or blocks it |
| `creative.refresh` | 09:30, once a week (Monday, after the Social Media Manager's report) | Reads the ad results, joined to assets by `utm_content`, proposes retiring tired creative and briefs new variants of the winners |
| `creative.report` | 09:45, once a week | Emails the owner a scorecard per asset (ad results and website leads by `utm_content`) and saves the learnings it supports |

**Run now** on the AI team page runs any of them on any day.

### Briefs and copy

A brief names the product, a goal, an audience (organizations and roles, never a health condition: the database refuses one), the
platforms, images and/or videos with their lengths, an optional angle and an optional offer code. The model is given the brief, the
product's own pages (by id), the brand kit's voice, banned phrases and required disclaimers, the owner's screenshots (by id and label), the
product's learnings and its recent headlines (not to repeat), and, for a revision, the asset it replaces and the owner's note. Its system
prompts (`server/agents/creative/copy.mjs`, versions `creative-concept.1` and `creative-variants.1`) carry the fact sheet and the sales
playbook (the Sales Executive's fact source) and are cached. The answers are closed JSON schemas.

Hooks: **problem** (a likely problem of the organization, as a question), **proof** (one concrete capability or fact from the fact sheet;
never the words "prove", "proof" or "evidence" about CareBase), **offer** (the free trial or the Founders Sale exactly as written),
**curiosity** (a loop the landing page closes, no clickbait) and **demo** (what the product does on screen).

Each variant gets one image per platform, taking the platform's placements in turn; the first two variants also get one video per
requested length per platform (not Google display). Every draft's landing address is the product page the concept chose, with
`utm_source`, `utm_medium=paid`, `utm_campaign=creative-<brief>` and **`utm_content=<the asset's id>`**, written by the database.

### Formats (`server/agents/creative/specs.mjs`)

Checked on 2026-11-09 against the platforms' own pages where they publish a value. A hard limit blocks the asset; a length the platform
only recommends (where the feed cuts text off) is a warning.

| Platform | Images | Videos | Copy |
| --- | --- | --- | --- |
| Meta | 1080×1080, 1080×1350, 1080×1920 (Stories, Reels); up to 30 MB | 1:1, 4:5 (feed: up to 241 minutes), 9:16 (Stories and Reels: kept to 60 seconds) | primary text ~125 shown (2,200 max), headline ~40, description ~30 |
| LinkedIn | 1200×627 (1.91:1; LinkedIn now recommends 1200×628), 1080×1080; up to 5 MB | 1:1, 4:5, 9:16; 3 seconds to 30 minutes | introductory text 150 shown (600 max), headline 70 shown (200 max), description 70 |
| Google display | 1200×628 and 1200×1200 (up to 5,120 KB); 300×250 (up to 150 KB) | none | short headline 30, long headline and description 90 |
| YouTube | thumbnail 1280×720 (up to 2 MB) | 1:1; 9:16 Shorts up to 3 minutes; bumpers up to 6 seconds | title 100 |

Video lengths: **6s**, **15s**, **30s** and **45-60s**.

### Rendering

**Images** are drawn with satori (an element tree, no browser) and turned into a PNG by @resvg/resvg-js at the placement's exact size.
Seven layouts: **headline**, **stat** (one fact-sheet number with its source), **screenshot** (a product screenshot in a window frame),
**quote** (CareMetric's own line, never a customer's), **offer** (the offer card), **checklist** and **split** (landscape). Each adapts to
square, portrait, tall (Stories keep the top 12% and bottom 18% clear), landscape and the small 300×250. Fonts (Geist and Inter) and the
brand files are bundled, so nothing is fetched while rendering.

### Brand themes (`server/agents/creative/themes.mjs`)

Every image and video is drawn in its product's brand theme: the colors, type, logo and look of the product's own app, read from the same
constants the Hub's emails use (`server/email-layout.mjs`), so an ad, a video and an email from one product look like one brand.

| | CareMetric Intel: **Emberline** | CareMetric CareBase |
| --- | --- | --- |
| Canvas | Near-black `#07080A`, dark cards `#101116` | White `#FFFFFF`, panels `#F8FAFC` |
| Brand color | Ember `#FF7A45` (kickers, rules, accents) | Blue `#2563EB` (kickers, rule, button) |
| Text | `#F4F4F6` headings, `#B9BCC6` body, `#8D919C` muted | `#0F172A` headings, `#334155` body, `#64748B` muted |
| Type | Geist | Inter |
| Logo | The reverse CareMetric Intel lockup (on dark only) | The CareBase lockup over a 3px brand-blue rule (on white only) |
| Button | White pill, near-black text | Blue, white text, 8px corners |
| Offer card | Emberline's callout (`#2A1913` / `#743B28` / `#FFD0B3`) | CareBase's callout (`#EFF6FF` / `#BFDBFE` / `#1E3A8A`) |
| Extras | The fire band along the bottom; the tagline "Set your marketing on FIRE!" on the video end card | None |

The logos and the fire band are bundled in `server/agents/creative/brand-assets/` (copied from each product's site; its README says how to
refresh them). The brand kit on the Creative screen overrides the theme field by field; a blank field uses the theme, so creative is on
brand before the owner sets anything. A theme logo is never put on a ground it was not made for (the product name is drawn instead), and
an uploaded logo replaces it. Where a color would fail contrast, the replacement is the theme's own darkest or lightest color, never one
from outside the brand. The copy prompts carry the theme too (`brandTheme`), so the words suit the look.

**Videos** (`HUB_CREATIVE_VIDEO_PROVIDER`):

- `internal` (default): each frame is drawn the same way and ffmpeg-static stitches them into an H.264 MP4 at 24 frames a second. A video is
  the hook (kinetic text: each word rises in), the beats in turn, a product screenshot with a slow pan and zoom (when the owner has one and
  the video is longer than 15 seconds, or the hook is "demo"), the offer or statistic, and a logo end card with the call to action.
  Captions are burned in by default (a dark band with the line being shown) and kept as WebVTT. If `server/agents/creative/music/` holds
  royalty-free tracks the company may use in paid ads, one is chosen per asset and faded in and out; otherwise videos are silent. A
  30-second video renders in about 8 seconds.
- `heygen`: a presenter video read from the asset's own copy, only when `HUB_HEYGEN_API_KEY` is set and the product's brand kit names a
  HeyGen avatar and voice; otherwise the internal renderer is used. HeyGen renders in the background; each render task checks on it, and
  the captioned file is downloaded from HeyGen's own asset hosts only. Each render HeyGen is asked for is written to the AI usage ledger.

satori, resvg and ffmpeg are loaded the first time something is rendered, never at server start, so a Hub where one cannot load still
starts; the asset is tried again later (and fails after three tries). The production image copies the ffmpeg-static binary from the build
stage (`Dockerfile`).


## Compliance (`server/agents/creative/compliance.mjs`)

Every rule gives pass, warn or block with a plain-words reason; an asset's verdict is the worst of them. **A blocked asset never reaches the
owner**: it is never proposed and the Creative screen only counts it. A warned asset is proposed with its warnings beside it and can never
be approved automatically (the database refuses one).

| Rule | What it checks | Level |
| --- | --- | --- |
| `phi` | No identifier (record, member or Medicare number, date of birth), no named patient, resident or person, nothing about a person's health or care | block |
| `personal_attributes` | No assertion or implication of the reader's health, finances, age or other personal attributes (Meta's personal-attributes policy) | block on Meta, warn elsewhere |
| `unsubstantiated_claim` | No guarantee, compliance assurance ("100% compliant", "ensures compliance", "pass your survey"), certification, superlative (#1, best, leading, only) or outcome promise, unless the exact claim is in the Sales Executive's fact source (fact sheet and sales playbook) | block |
| `government_endorsement` | Nothing that says or implies CMS, Medicare, Medicaid, a state or another government body approves, endorses, certifies or partners with CareMetric. Public data is fine | block |
| `offer_mismatch` | Only billing's live offers (`offers.mjs`, read from the Founders Sale coupon: FOUNDERS50, 50% for the first 12 months, CareBase and Intel only), with their own percentage and length; no code to type (the Founders Sale applies itself); no invented deadline or scarcity; only this product's listed prices | block |
| `brand_name` | "CareMetric" is one word, exactly so; CareBase, CareMetric Intel, Intel exactly | block |
| `banned_phrase`, `required_disclaimer` | The brand kit's lists | block |
| `fact_sheet` | Every other fact-sheet rule the Content Marketer and Sales Executive follow: unlisted numbers, competitors, testimonials, voice AI, a call or demo as a step, "prove" about CareBase, the fixed vocabulary, contact details, mentions of AI, and any offer of a call, meeting, demo or time to talk (`offersMeeting`, the check the Social Media Manager runs on every post and ad: CareMetric does no personal demos) | block |
| `brand_colors` | Every color the asset paints (text, fills, borders, in every video frame) is one of the product's brand colors: its theme's or one the owner set in the brand kit. A render that does not report its colors is blocked | block |
| `contrast` | WCAG AA for every text run (4.5:1, or 3:1 for large text, judged at the size a feed shows it). The layouts keep a color only where it passes and otherwise use the theme's own darkest or lightest color | block |
| `brand_deviation` | A color the owner set in the kit replaced for contrast, or a font the Hub does not bundle (the theme's font is used) | warn |
| `images` | Only the logo (the owner's or the theme's), the theme's own brand imagery (Intel's fire band) and screenshots the owner attested carry no patient, resident or personal information | block |
| `captions` | Every video has burned-in captions | block |
| `text_heavy` | Text covers more than a fifth of the picture (for a video, its busiest frame) | warn |
| `platform` | The specs above: size, type, file size, video length, copy limits | block or warn |

## Approving, rejecting, asking for changes

Each finished asset is a proposal on the AI team page and on the Creative screen: `creative.asset` (passed every check) or
`creative.asset_review` (passed with warnings). The card shows the platform, placement, size, variant and hook, the compliance result, the
copy and the landing page; the Creative screen also shows the image or plays the video, lists the brief's variants side by side, and offers
a download.

- **Approve**: the executor hands the asset to the Social Media Manager (`private.creative_handoff`): it becomes `approved` and gets an
  unguessable public address (`/api/creative/a/<token>.png`) that Meta and LinkedIn fetch while it is approved or live, and never after.
  The database hands it over only inside the execution it started for an approved action.
- **Reject**: the asset becomes `rejected`. **Request changes** is a rejection with a note (required): the note becomes a **revision
  brief** in the same transaction (a database trigger), with a task to draft it, and the new variants come back for approval.
- A proposal nobody decides within seven days expires.

### What the Social Media Manager does with approved creative

Backward compatible: without approved creative it works exactly as before.

- **Posts**: an Instagram or LinkedIn post in the weekly plan uses an approved image of that product and platform before the configured
  image list (`HUB_SOCIAL_IMAGE_URLS`), once each. An Instagram post can now be planned with approved creative and no image list.
  Facebook posts stay link posts.
- **Ads**: when the daily ad review asks for a new ad, approved creative for the product and platform is used before writing new copy: its
  primary text, headline and description (checked again with the social checks), its image (Meta fetches it as the ad's picture) and its
  landing address with `utm_content`.
- Publishing a post or starting an ad from an asset marks it `live`.

## Learning

Results are joined to assets by `utm_content`: an ad whose link carries an asset's id is that asset's ad, and a website lead whose
`utm_content` is an asset's id came from it (test leads never count). Each week:

- **Fatigue** (`performance.mjs`): an asset is tired when at least two of three signals agree, week over week, once it has 1,000
  impressions in each week: click-through rate down 20% or more, more than 3 views per person, cost per thousand impressions up 20% or more.
  `creative.refresh` proposes retiring it (`creative.retire`; the Social Media Manager's own daily review pauses the ad) and briefs new
  variants of up to two winners per product (the best click-through rate that is not tired).
- **Learnings**: each hook, layout, placement and video length is compared with the product-and-platform average (lead rate when there are
  leads, click-through rate otherwise); 15% better is a win, 15% worse a loss. Learnings (`private.creative_learnings`) feed every future
  brief, the weekly report and the Chief of Staff's morning brief ("Creative: … Working best: …").

## The Creative screen (`/admin/creative`)

Light theme, one column on a phone. Status counts (and how many were blocked), filters by product, platform and status, the gallery with
image and video previews, compliance badges, approve / reject / request changes with a note, download, variants side by side; a **New
brief** form; the learnings; recent briefs; and a **brand kit editor** per product: the theme's colors as swatches, colors (#RRGGBB, each
blank field showing the theme color it uses, with **Use theme** to go back to it), fonts (Geist or Inter; blank uses the theme's), voice notes, required
disclaimers, banned phrases, HeyGen avatar and voice ids, burned-in captions, the logo (PNG or JPEG, up to 1 MB) and product screenshots
(up to 5 MB each, 12 per product, each with the owner's attestation that it shows no patient, resident or personal information). Every
change needs a current command session, is audited (`creative.brand_kit`, `creative.brand_file`, `creative.brief`), and is refused from a
stale screen.

## Autonomy steps (both off)

| Step | Hands over | Never |
| --- | --- | --- |
| **Creative approvals** (`creative_assets`) | `creative.asset`: an asset that passed every check with no warning is approved on its own | An asset with a warning (`creative.asset_review`): the database refuses an automatic approval |
| **Retiring tired creative** (`creative_retire`) | `creative.retire` | |

Each follows the usual supervised week on the AI team page.

## Boundary and storage

The five tables (`private.brand_kits`, `creative_briefs`, `creative_assets`, `creative_files`, `creative_learnings`) have row level
security and no privilege for any role. The server reaches them only through `private.creative_*` security definer operations (Hub server
only); the owner through `hub.get_creative_studio`, `hub.get_creative_file`, `hub.set_brand_kit`, `hub.add_brand_file`,
`hub.remove_brand_file` and `hub.create_creative_brief`, which authorize the owner's session themselves. The gate migration declares the
feature only when all of that holds.

Finished files and brand files are kept in `private.creative_files` (bytea, at most 60 MB a file) rather than Storage, because the server
renders on its own clock without the owner's session and Storage has no session-less path for it. Only an approved or live asset is ever
served publicly, and only under its token.

## Switching it on

1. Apply `20261109200000_creative_director.sql`, then its gate `20261109200100_creative_director_contract.sql` (it needs the AI team control
   plane, hardening, autonomy steps, the Social Media Manager, the marketing switches and the lead desk). Restart the Hub so it reads
   `platform.agents.creative.v1`.
2. Set on the Hub service: `HUB_CREATIVE_ENABLED=true` (with `HUB_AGENTS_ENABLED=true` and `ANTHROPIC_API_KEY`). Optional:
   `HUB_CREATIVE_DAILY_RENDER_CAP` (default 40), `HUB_CREATIVE_VIDEO_PROVIDER=heygen` with `HUB_HEYGEN_API_KEY`.
3. Optionally open **Creative** and add to each marketed product's brand kit: voice notes, banned phrases, required disclaimers and
   attested product screenshots. The colors, type and logo already come from each product's brand theme; set one only to change it.
4. On **AI team**, resume the Creative Director (it stays in **Propose**), then either press **Run now** on "Turn marketing plans into
   briefs" or start a **New brief** on the Creative screen. Finished assets appear within about ten minutes.

To stop it: pause the Creative Director, or unset `HUB_CREATIVE_ENABLED` (approvals already given are still carried out). To take an
approved asset out of use at once, run `update private.creative_assets set status = 'retired', public_token = null, retired_at = now()
where id = '<id>';` (the weekly refresh also proposes retiring tired creative).

## Cost

Two model calls per brief: the concept and final copy on the quality tier (up to 4,000 output tokens) and the variants on the draft tier (up
to 5,000). The seeded daily budget is $3.00; a used-up budget puts the brief off to the next Eastern day. Rendering uses no model. HeyGen
renders are billed by HeyGen and logged in the AI usage ledger.
