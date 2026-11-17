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
                                   creative.render (every 10 min, daily cap) ──► render ──► full compliance check ──► image review (when on)
                                                                                   │            │                         │
                                                                   blocked (never shown)   proposed ◄─────────────────────┘ ──► owner
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
| `creative.render` | Every 10 minutes | Proposes rendered assets, collects finished HeyGen renders, renders drafts (at most Settings → Creative → "Most renders a day", default 40, across every server), checks each finished asset in full and proposes it, or blocks it |
| `creative.refresh` | 09:30, once a week (Monday, after the Social Media Manager's report) | Reads the ad results, joined to assets by `utm_content`, proposes retiring tired creative and briefs new variants of the winners. Emails the owner only when it proposed something or an ad platform could not be read (since 2026-11-17) |
| `creative.report` | 09:45, once a week | Emails the owner a scorecard per asset (ad results and website leads by `utm_content`) and saves the learnings it supports. With no live asset, nothing waiting for approval and every ad platform read, it sends nothing (since 2026-11-17) |

**Run now** on the AI team page runs any of them on any day.

### Briefs and copy

A brief names the product, a goal, an audience (organizations and roles, never a health condition: the database refuses one), the
platforms, images and/or videos with their lengths, an optional angle and an optional offer code. The model is given the brief, the
product's own pages (by id), the brand kit's voice, banned phrases and required disclaimers, the owner's screenshots (by id and label), the
product's learnings and its recent headlines (not to repeat), and, for a revision, the asset it replaces and the owner's note. Its system
prompts (`server/agents/creative/copy.mjs`, versions `creative-concept.9` and `creative-variants.9`) carry the fact sheet and the sales
playbook (the Sales Executive's fact source) and are cached. The answers are closed JSON schemas.

**What each product does** (`server/agents/content/features.mjs`, data in `intel-features.json` and `carebase-features.json`). Each brief's
model calls carry its product's published catalog as a second cached block after the prompt:

- **CareMetric Intel**, from https://www.caremetricintel.com/features and its home page: every feature (125 in 12 areas: the healthcare
  marketing CRM, daily field work, expenses, mileage and Stark-limit tracking, referral and admission tracking with EMR report imports,
  prospecting, market and territory research, the public data library, competitor intelligence, manager tools, email campaigns, reports,
  and administration) with the plan or role it needs; why each part matters (the site's twelve pillars; email campaigns, expenses and the
  pre-visit card and spoken debrief never lead a brief); the data behind it (providers, facilities, Medicare use and share, demographics,
  payers and Medicare Advantage, community need, competitors, and the organization's own results), each with what is included, its
  source (NPPES, CMS files and Care Compare, the Census Bureau's American Community Survey, state licensing files and other federal
  sources), the decision it helps make and its limit; each care setting the site describes, with the secondary markets
  labeled as such (briefs aim only at the primary five); the manager view; the questions and answers; and the site's own caveats.
- **CareMetric CareBase**, from https://cmcarebase.com/features, its home page and /faq: every capability (112 in 8 areas: resident care and
  daily operations, staff training, medication management and eMAR, survey readiness and safety, workforce and scheduling, resident
  billing and payments, AI assistance with human review, and access and onboarding), each area with the plan or add-on it needs and its
  own notes; why it matters and the tools that set it apart; the newest tools (Survey Day Mode, the compliance copilot, clinical records);
  a resident's record from inquiry to move-out; what each role sees and does; before and with CareBase; each chapter's requirements; the
  questions and answers; and the site's own caveats (CareBase guarantees no compliance, and native eMAR needs enrollment, clinical
  approval and a documented switch).

The model is told to sell one feature per asset by the decision it helps make or the work it saves, to vary features across variants, to
respect plan and module labels, and never to imply that public data confirms referrals, that a tool makes anyone compliant or survey-ready,
or that a readiness score predicts a survey. Planned briefs each lead with a different pillar (the one the plan post is about, else the
next in turn), except Intel's email campaigns and expenses pillars, which never lead a brief: on 2026-11-12 the owner directed that
sending emails to referral sources is not the point of Intel and never the whole focus, and on 2026-11-14 that Intel is a marketing
workspace, not a compliance product, with expense tracking a small part of it (`focusFor` in `server/agents/content/features.mjs`; the fact
sheet's "How to present it"). Copy must catch the eye at once and still be clear (owner direction 2026-11-14: the plain copy was accurate but
weak as marketing). The headline is drawn large on the image and opens every video, so it is written to stop the scroll: three to seven
words, the punch in the first few, using a moment the reader knows, the question they already ask, the frustration said out loud, a sharp
contrast or a "stop doing this". Neither the headline nor the primary text opens with CareMetric, the product, a feature or a line any
software ad could use; the kicker can call out who the ad is for by their work, and the primary text's first sentence and a video's first
beat are second hooks. The model writes like a direct-response copywriter: it starts from the reader's week, puts the benefit up front and
uses the feature as the reason to believe, names real things (the surveyor, the binder, the referral source), and sounds like a confident
peer, not a brochure. It is shown flat lines beside better ones on the same facts (`craftExamples`; `copy.test.mjs` holds every better
line to the copy rules and the hook rules), writes several headlines and keeps the one that would stop a busy reader, and rereads its lines
before it answers. It must still be clear: a headline that makes sense on its own
and complete sentences (the fact sheet's "How everything must read"), and the `plain_language` rule below refuses the worst of it. A catalog's numbers are allowed in copy about its own product only ("up to 2,000 accounts" for Intel, "16 hours of annual
training" for CareBase); a catalog vouches for no claim, and its percentages are not allowed. The Content Marketer, the Sales Executive and
the Social Media Manager use the same catalogs (docs/AI_TEAM.md, "What each product does"). Refresh them with `npm run refresh:features`
when a product's pages change (`npm run refresh:features -- --check` says whether they have). Other products' names are written
generically, and the CareBase FAQ's demo and sales-call sentences are left out, because the team offers neither; each catalog lists its
edits.

**Audiences come from the fact sheet's "who it is for"**, so creative never narrows a product to part of its market. CareMetric Intel is
for home health agencies, hospice agencies, hospitals, nursing homes and personal care homes; CareBase for Pennsylvania personal care homes
and Assisted Living Facilities. The prompts say so, and tell the model to write for the audience the brief names (an "agency" is home
health or hospice; a hospital, nursing home or personal care home is not) or, for several, for what they share. Briefs from the marketing
plans aim each Intel brief at one kind of organization, taking turns across all five from week to week; a plan item that already names
one (a post about hospital liaisons) keeps it. A refresh of a winner, and the owner's own briefs, name their audience.

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
| Logo | The reverse CareMetric Intel lockup, white on transparent | The CareBase lockup on transparent (the site's header copy) over a 3px brand-blue rule |
| Button | White pill, near-black text | Blue, white text, 8px corners |
| Offer card | Emberline's callout (`#2A1913` / `#743B28` / `#FFD0B3`) | CareBase's callout (`#EFF6FF` / `#BFDBFE` / `#1E3A8A`) |
| Extras | The fire band along the bottom; the tagline "Set your marketing on FIRE!" on the video end card | None |

The logos and the fire band are bundled in `server/agents/creative/brand-assets/` (copied from each product's site; its README says how to
refresh them). The brand kit on the Creative screen overrides the theme field by field; a blank field uses the theme, so creative is on
brand before the owner sets anything. Where a color would fail contrast, the replacement is the theme's own darkest or lightest color,
never one from outside the brand; a button, rule or bar that would vanish into the background (a kit's brand-color canvas) takes the
theme's own light or dark color the same way. The copy prompts carry the theme too (`brandTheme`), so the words suit the look.

**Logos** (`server/agents/creative/logo.mjs`). A logo is only ever placed on a background it sits on cleanly, so creative never shows a
logo's own white box on a colored or dark background. Each logo is measured once: a **cut-out** logo (transparent background) goes where
at least 85% of its drawn pixels reach 3:1 against the background; a logo with a **solid** background of its own (every JPEG, and a PNG
saved on white) goes only on a background of that same color; a logo whose edges are a picture goes nowhere. The order is the owner's
uploaded logo, then the product's official logo, then the product name beside a bar of the brand color. When the owner's logo had to give
way, the asset carries a `brand_deviation` warning saying why, and a render that places a logo anywhere else is blocked (`logo_ground`).
Intel's white lockup sits on its dark canvas (or brand blue); CareBase's on white and its light panels. Stacked layouts also size their
words to the height they have, and nothing on a page is squeezed to make room, so a crowded offer never pushes the logo out.

**Videos** (Settings → Creative → "How videos are made"):

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
| `unsubstantiated_claim` | No guarantee, compliance assurance ("100% compliant", "ensures compliance", "pass your survey"), certification, superlative (#1, best, leading, only) or outcome promise, unless the exact claim is in the Sales Executive's fact source (fact sheet and sales playbook) ; also any promise of compliance however phrased ("stay Stark-compliant", "never exceed the Stark limit", "avoid violations") | block |
| `government_endorsement` | Nothing that says or implies CMS, Medicare, Medicaid, a state or another government body approves, endorses, certifies or partners with CareMetric. Public data is fine | block |
| `offer_mismatch` | Only billing's live offers (`offers.mjs`, read from the Founders Sale coupon: FOUNDERS50, 50% for the first 12 months, CareBase and Intel only), with their own percentage and length; no code to type (the Founders Sale applies itself); no invented deadline or scarcity; only this product's listed prices | block |
| `brand_name` | "CareMetric" is one word, exactly so; CareBase, CareMetric Intel, Intel exactly | block |
| `banned_phrase`, `required_disclaimer` | The brand kit's lists | block |
| `plain_language` | Easy to read and makes sense on the first pass (owner direction 2026-11-12): no empty buzzword (unlock, empower, leverage, seamless, solution and the like), no string of one- or two-word fragments ("Territory. Clarity. Growth."), no sentence over 30 words (`unclearCopy` in `server/agents/content/validate.mjs`; `creative-compliance.2`) | block |
| `fact_sheet` | Every other fact-sheet rule the Content Marketer and Sales Executive follow: unlisted numbers, competitors, testimonials, voice AI, a call or demo as a step, "prove" about CareBase, the fixed vocabulary, contact details, mentions of AI, and any offer of a call, meeting, demo or time to talk (`offersMeeting`, the check the Social Media Manager runs on every post and ad: CareMetric does no personal demos) | block |
| `brand_colors` | Every color the asset paints (text, fills, borders, in every video frame) is one of the product's brand colors: its theme's or one the owner set in the brand kit. A render that does not report its colors is blocked | block |
| `contrast` | WCAG AA for every text run (4.5:1, or 3:1 for large text, judged at the size a feed shows it). The layouts keep a color only where it passes and otherwise use the theme's own darkest or lightest color | block |
| `logo_ground` | Every logo is placed where it sits cleanly (see Logos above): never a logo's own white box on a colored or dark background, and never a logo the renderer did not say fits | block |
| `brand_deviation` | A color the owner set in the kit replaced for contrast, the owner's logo left out on a background it does not fit (and why), or a font the Hub does not bundle (the theme's font is used) | warn |
| `images` | Only the logo (the owner's or the theme's), the theme's own brand imagery (Intel's fire band) and screenshots the owner attested carry no patient, resident or personal information | block |
| `captions` | Every video has burned-in captions | block |
| `text_heavy` | Text covers more than a fifth of the picture (for a video, its busiest frame) | warn |
| `vision_defect` | The image review saw text cut off, overlapping or too faint to read, a garbled word, a figure that differs from the one meant, or part of the image broken (see The image review) | block |
| `vision_note`, `vision_weak`, `vision_unreviewed` | The image review noted a softer problem (crowded, or anything else), scored the image below "Least score from the image review", or could not look at it | warn |
| `platform` | The specs above: size, type, file size, video length, copy limits | block or warn |

## The image review (2026-11-16)

The coded checks above read the words and measure the colors, but nothing looked at the finished picture. With **Settings → Creative →
Have a model look at each image before you see it** on (off by default), every static image that rendered and passed every coded check is
shown to a model (`server/agents/creative/vision.mjs`, prompt `creative-vision.1`, on the draft tier) before you are asked about it:

1. It reads back every word and number it can see, in reading order.
2. It lists what is visibly wrong: text cut off, overlapping or too faint to read at feed size, a garbled word, a number that differs from
   the one the image was meant to show (or one it was not meant to show), part of the image broken, crowded, or anything else the company
   would be embarrassed to run.
3. It reads the image as its audience would (the brief's audience, or an owner or director of business development at the kind of
   organization the product is for, scrolling between appointments) and scores from 1 to 5 whether they would stop and read it, with one
   sentence on what they take from it and the one change that would most make them stop.

A defect a reader would see blocks the image, so it is never shown to you (`vision_defect`; the server logs the defects and the layout so
a layout that keeps failing can be fixed). A softer one, or a score below **Least score from the image review** (default 3), is a warning
beside the image, and the database never approves an image with a warning on its own. When the review cannot run (today's budget is
spent, the model is unavailable or not set up, the file is over 5 MB) the image is shown with a warning that it was not reviewed, never
passed unseen. The Creative screen
shows the score and the reader's sentence on the card. The model's answer is kept in the asset's compliance result (`review`); the
picture is not kept anywhere else. Videos are not reviewed this way: their captions and frames are checked by code.

The runtime sends the PNG as an image block before the words that ask about it; the budget reservation counts an image at the API's
per-image ceiling (about 4,800 tokens), not its bytes.

**Version 2 (2026-11-17, [review](AI_WORKFORCE_REVIEW_2026-11-17.md)).** The first version blocked 18 of the 24 images it saw, almost all
for the brand's own small print: the site address in the footer and the product name inside the logo were "too small to read", and the
supporting line ("Try Intel free for 30 days") was "a number the image was not meant to show", because nobody had told the reviewer it
was there. Now (`creative-vision.2`):

- The reviewer is told every string the layout actually drew, element by element (`drawn`: headline, kicker, body, stat, checklist, call
  to action, source, site address), from the layout's own report, and which parts are the brand's furniture (the logo lockup, the site
  address, the fire band, which runs off the bottom edge by design). A number in `drawn` is never a wrong figure.
- Each defect names its element. A cut-off, overlapping, garbled or broken part blocks wherever it is; an unreadable word or a wrong figure
  blocks on the ad's own words, warns on its small print (a source, fine print) and is only noted on the furniture.
- The layouts changed where the review saw real faults: the checklist draws every item (up to five) on every canvas, stepping its size
  down before an item gives way (never below three; the landscape image used to draw three of five); the headline layout fits its
  headline and supporting line to the room between the header and the footer; the supporting line is a whole sentence or nothing, never
  cut off with "…"; and small print is never under 2.2% of the width (on a landscape canvas it was about 16 pixels).
- Images blocked only by the first version (while the review is on) go back to the render queue once
  (`private.creative_render_requeue`, `20261117180000_work_recovery.sql`), and are reviewed again under version 2.

## Approving, rejecting, asking for changes

Each finished asset is a proposal on the AI team page and on the Creative screen: `creative.asset` (passed every check) or
`creative.asset_review` (passed with warnings). The card shows the platform, placement, size, variant and hook, the compliance result, the
copy and the landing page; the Creative screen also shows the image or plays the video, lists the brief's variants side by side, and offers
a download.

- **Approve**: the executor hands the asset to the Social Media Manager (`private.creative_handoff`): it becomes `approved` and gets an
  unguessable public address (`/api/creative/a/<token>.png` or `.mp4`) that Meta and LinkedIn fetch while it is approved or live, and never after.
  The database hands it over only inside the execution it started for an approved action.
- **Reject**: the asset becomes `rejected`. **Request changes** is a rejection with a note (required): the note becomes a **revision
  brief** in the same transaction (a database trigger), with a task to draft it, and the new variants come back for approval.
- A proposal nobody decides within seven days expires.

### What the Social Media Manager does with approved creative

Backward compatible: without approved creative it works exactly as before.

- **Posts**: with the social video migration installed, the weekly plan can publish approved MP4 creative as a Facebook Page video,
  Instagram Reel (vertical placement only), or LinkedIn Page video. The post still needs its own approval or the owner's existing
  social-post hand-over. Otherwise, Instagram and LinkedIn use an approved image of that product and platform before the configured
  image list (`HUB_SOCIAL_IMAGE_URLS`), once each; Facebook uses a link post. Instagram can be planned with approved creative and no image list.
- **Ads**: when the daily ad review asks for a new ad, approved creative for the product and platform is used before writing new copy: its
  primary text, headline and description (checked again with the social checks), its image (Meta fetches it as the ad's picture) and its
  landing address with `utm_content`. Already approved creative can be used even when the model is not connected; only drafting fresh
  copy requires the model.
- Publishing a post or starting an ad from an asset marks it `live`.

Video publication needs `20261111031736_social_video_publication.sql` and its contract migration, then a Hub restart. The stored
upload and publication stages let the worker wait for processing across runs without uploading or publishing twice. An uncertain
send stops for the owner to inspect the platform. LinkedIn uploads are capped at 60 MiB; processing times out after an hour. See
[Social media](SOCIAL_MEDIA.md#approved-video-posts) for platform permissions and recovery. Paid video ads and YouTube publication
remain manual; the ad refresh tool uses approved images.

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
disclaimers, banned phrases, HeyGen avatar and voice ids, burned-in captions, the logo (PNG or JPEG, up to 1 MB; the screen asks for a PNG
with a transparent background, which fits every layout) and product screenshots
(up to 5 MB each, 12 per product, each with the owner's attestation that it shows no patient, resident or personal information). Every
change needs a current command session, is audited (`creative.brand_kit`, `creative.brand_file`, `creative.brief`), and is refused from a
stale screen.

### Your own finished videos (Creative → Add a finished video)

A video made outside the Hub (a product intro, a commercial) joins the library the team uses. The owner picks an MP4 of at most 60 MB and
two minutes, names it, ticks where it may be used and attests that it shows no patient, resident or personal information. The server
reads the length and picture size from the file itself (`server/agents/creative/mp4.mjs`) and checks each placement (`specs.mjs`):

| Size | Placements |
| --- | --- |
| 1080 x 1920 (9:16) | Instagram Reels and Facebook (`meta.video_vertical`, at most 60 seconds); LinkedIn (`linkedin.video_vertical`) |
| 1080 x 1080 (1:1) | Facebook feed (`meta.video_square`); LinkedIn (`linkedin.video_square`) |
| 1080 x 1350 (4:5) | Facebook feed (`meta.video_portrait`); LinkedIn (`linkedin.video_portrait`) |
| 1920 x 1080 (16:9) | Facebook feed (`meta.video_landscape`); LinkedIn (`linkedin.video_landscape`) |

The 16:9 placements are for uploads only: the Creative Director does not render them. Adding the video approves it, one asset per
placement (one per platform), each with its own public token, `provider` `owner` and an `upload` brief
(`20261113250000_creative_uploads.sql`, `hub.add_creative_video`, audited as `creative.video_upload`; the same upload sent twice is stored
once). Nothing is published by the upload: the Social Media Manager uses the video in its next weekly plan, once per placement, and each post
still waits for the owner's approval. Retire it like any approved asset.

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
2. In **Settings → Creative**, switch on **Turn on the Creative Director** (with **Settings → AI team → Run the AI team** on and
   `ANTHROPIC_API_KEY` set). Optional, in the same group: **Most renders a day** (default 40) and **How videos are made** (HeyGen presenter
   videos also need `HUB_HEYGEN_API_KEY`, a secret, in Railway). A change applies within a minute, with nothing to redeploy.
3. Optionally open **Creative** and add to each marketed product's brand kit: voice notes, banned phrases, required disclaimers and
   attested product screenshots. The colors, type and logo already come from each product's brand theme; set one only to change it.
4. On **AI team**, resume the Creative Director (it stays in **Propose**), then either press **Run now** on "Turn marketing plans into
   briefs" or start a **New brief** on the Creative screen. Finished assets appear within about ten minutes.

To stop it: pause the Creative Director, or switch off **Settings → Creative → Turn on the Creative Director** (approvals already given are
still carried out). To take an
approved asset out of use at once, run `update private.creative_assets set status = 'retired', public_token = null, retired_at = now()
where id = '<id>';` (the weekly refresh also proposes retiring tired creative).

## Cost

Two model calls per brief: the concept and final copy on the quality tier (up to 4,000 output tokens) and the variants on the draft tier (up
to 5,000). The seeded daily budget is $3.00; a used-up budget puts the brief off to the next Eastern day. Rendering uses no model. The
image review, when on, is one draft-tier call per static image (about 1,000 to 2,800 image tokens and a short answer: about a cent),
from the same budget. HeyGen renders are billed by HeyGen and logged in the AI usage ledger.

## County snapshots (2026-11-13)

With Settings → Creative → County snapshots a week above 0 (default 3), the daily plan opens briefs for counties, none pictured in the last
eight weeks, each about one public figure from Intel's county figures. Code fixes the figure, its label and its short source
(`server/agents/creative/data.mjs`) and every variant is drawn with the stat layout; the model writes only the words around it. A draft
that changes the figure, or writes a number of its own (the data's year aside), is blocked (`data_figure`, `data_number`), and any stat
image now needs its source (`stat_source`). The figures are Medicare fee-for-service unless their label says otherwise.

Since 2026-11-16 (`20261116130000_creative_review.sql`, feature `platform.agents.creative-review.v1`):

- **One care setting each** (owner decision 2026-11-16: keep it in the agency's own industry). A snapshot is about home health or about
  hospice: it shows that setting's figure, or a general one about the county's people, to that setting's agencies, and its brief tells the
  model to say nothing about another setting. The setting is the only one with roster agencies located in the county, else the one the
  county was not pictured with last time, else by week.
- **Concentration and crowding first.** Each setting's figures, in turn by week: the share of the Medicare patients of the agencies
  located in the county that its three largest served (`*_top3_share`, from Intel, only where CMS counted every agency located there
  and at least five are; never a name), how many agencies billed Medicare for the county's residents (including agencies located in
  other counties), how many and what share of beneficiaries used that setting, then beneficiaries aged 85 and over, growth in residents
  aged 65 and over since 2020, Medicare Advantage's share and the rest. A long label steps down to fit three lines.
- **Every county of the roster's states.** The server asks Intel for the states' counties (`counties`) and the database picks the least
  recently pictured first, then those with the most roster agencies (`private.creative_data_counties(integer, timestamptz, jsonb)`),
  so a county with no agency located in it (three of Pennsylvania's 67) takes its turn too. Without the list, the roster's own counties,
  as before.
- **To the free market report.** Every snapshot sends agencies to the free market report for their own agency (`/market-review`),
  whatever page the concept chose.
- **Why none.** A plan run that opens no snapshot says why in its result (`snapshotsSkipped`: `off`, `feed_not_configured`,
  `database_not_ready`, `no_county_due`, `no_figure_fits`, or the feed's error code). Until the Hub restarts after the migration that
  declares a feature, it does not see it: the November 15 run opened none because the data creative migration reached production that
  evening.

Since 2026-11-17 (`20261117180000_work_recovery.sql`, feature `platform.agents.work-recovery.v1`; [review](AI_WORKFORCE_REVIEW_2026-11-17.md)):

- **Checked the same way when drafted and rendered.** Every snapshot rendered on November 16 was blocked: the render read the code-printed
  figure ("72%") as a number the fact sheet does not state. A snapshot is now checked at render against its brief's data, as it was when
  drafted (`copyFindings` in `server/agents/creative/tasks.mjs`; `creative-compliance.3`), and the snapshots blocked that way are rendered
  once more.
- **Alt text from the data.** A model describing a stat image repeats its number, which the words around the figure may not carry, so
  code writes a snapshot's alt text from the figure, its label and its source (`snapshotAltText`), and the checks read it as the figure.
- **A blocked snapshot frees its county.** A county counts as pictured only while its snapshot is still in the works or one of its images
  survived the checks (`private.creative_brief_pictured`). A county whose snapshot was all blocked waits a week, not eight, and gives the
  week its room back, up to twice the week's number of snapshots opened.
