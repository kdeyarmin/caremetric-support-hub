# Your own email sequences

Owner handoff of November 27, 2026 ("Pennsylvania cold email, batch 1"): send a three-email sequence the owner wrote, word for word, to
people the owner chose, on dates the owner chose, in the owner's name, and hand the owner the replies. The Marketing Manager's own cold
email cannot do that: it writes its own words, lays an Intel email out as a designed page and paces sends by its own rules. A sequence is
the owner's exact emails, reviewed once on Growth and then sent by the Marketing Manager.

Code: `server/growth/owner-sequence.mjs` (the copy, the send list, preparation and the `growth.sequences` task),
`src/admin/OwnerSequences.tsx` (Growth → Your own sequences), `supabase/migrations/20261127150000_owner_sequences.sql` and its gate
`20261127150100_owner_sequences_contract.sql` (feature `platform.agents.owner-sequences.v1`).

## Sending batch 1

1. Apply the two migrations, deploy, and check that Growth shows **Your own sequences**.
2. In Settings → Email, set **Growth email sender** to a mailbox in Kevin's name on a domain authenticated in the Hub's SendGrid account (see
   [A separate sender for prospecting](CUSTOMER_GROWTH.md#a-separate-sender-for-prospecting)). The display name is "Kevin Deyarmin" unless
   **Growth email display name** is set, which wins. Replies go to the support inbox's Reply-To, where the Hub reads them.
3. On Growth → Your own sequences → Prepare a sequence from a send list: name "Pennsylvania cold email, batch 1", campaign tag
   `pa-cold-email`, dates **December 1, December 4 and December 9, 2026**, most emails a day 8, and the send list `pa-batch1-send-list.csv`.
   Preparing takes a minute: each agency is matched to its CMS certification number and its report link is checked.
4. Read the **Left out** list and every person's three emails. Each row says whether the agency gets its own market report or the county
   report email, and when the report's county replaced the list's.
5. Tick "I read every email above" and **Approve and schedule**.
6. Turn on Settings → Customer growth → **Send your own email sequences**. The Marketing Manager must be resumed (Propose or Act; Observe
   holds everything) and Settings → AI team → Run the AI team must be on.

From then on each run (every five minutes) first reports what changed, then sends at most one due email: email 1 to the 8 people on
December 1 from 9:00 Eastern, about one every five minutes, then email 2 on December 4 and email 3 on December 9.

## What the handoff asked, and where it is kept

| Handoff rule | How the Hub keeps it |
| --- | --- |
| 1. Sender: Kevin's mailbox or a Hub mailbox in his name; never Intel's SendGrid or Amazon SES | The Hub's growth sender, through the Hub's own SendGrid key (`HUB_SENDGRID_API_KEY`), never Amazon SES whatever **Growth email service** says. Confirm that key belongs to a SendGrid account separate from Intel's. |
| 2. At most 20 to 30 cold emails a day from one mailbox; 8 a day for this batch | The sequence's own limit (8), and a sequence email goes out only while the day's prospecting emails from the growth sender (the sequences' and the Marketing Manager's own cold email together) number fewer than 25 (`private.owner_sequence_claim`). The Marketing Manager's cold email does not count the sequences toward its own cap, so keep Settings → Customer growth → Most cold emails a day low enough (10 or fewer) that the two stay within 20 to 30. |
| 3. Plain text, one recipient per message, no attachment, image or tracking pixel | The approved words are the whole text part; there is no HTML part. SendGrid's open, click and subscription tracking are off. Each email carries one-click unsubscribe headers (not visible in the message). |
| 4. Weekdays 9 to 11 Eastern on December 1, 4 and 9 | An email is sent only on a weekday, between 9:00 and 11:00 Eastern, on or after its date, after the person's previous email went out on an earlier day. A server outage carries an email to the next weekday's window rather than sending two to one person in a day. |
| 5. Stop on any reply, a bounce, or an auto-reply saying the person left; a hard bounce removes the contact | Before each email and on every run, the database reads replies from the address and from the agency's own domain since the first email. Any reply stops the person; an out-of-office reply is noted and stops nothing unless it says the person has left. Any bounce stops the person; a hard bounce also suppresses the address. No other address is ever tried. |
| 6. Opt-outs are permanent, in this and every later batch | "No thanks", "not interested", "unsubscribe", "remove me" and the like, a spam complaint or the one-click unsubscribe put the address (as its hash), the agency's domain and its CCN on `private.outreach_do_not_contact`. No later sequence takes them (preparing leaves them out; saving and approving refuse them) and the Marketing Manager's own cold email never writes to an organization on that domain (`private.growth_outreach_stopped`). |
| 7. Do not change the facts | The copy is in code (`templates` in `owner-sequence.mjs`), word for word, with only blank lines between paragraphs; `owner-sequence.test.mjs` pins every email. Only the merge fields change. |
| 8. The founder line | "I've managed a home health and hospice company…", never "own". The Marketing Manager's own founder story was corrected the same day (GTM facts, 2026-11-27). |
| 9. Replies go to Kevin; he approves any answer | Each reply is an alert to the owner and sits in Communications. The Support Concierge never answers or acknowledges a sequence's person (or a colleague on the agency's domain) on its own: `agent_answer_begin` and `agent_acknowledge_begin` refuse with `owner_sequence` unless the owner approved. |
| The two kinds of cold email stay apart | A sequence leaves out an agency the Marketing Manager emailed in the last 90 days, matched by its address, its domain or the CCN the roster tied to the organization it wrote to (batch 1's All Care Home Care had had three emails to an address on another domain). And the Marketing Manager's own cold email leaves alone, for 180 days from approval, any organization whose domain, or a CCN the roster tied to it, is a person of an approved sequence (`private.growth_outreach_stopped`; `20261127210000_owner_sequence_guard.sql`, feature `platform.agents.owner-sequence-guard.v1`). |
| 10. Not the 17 skipped agencies, nor Cambria and its seven neighbours | The send list holds only the 8. A row in Cambria, Clearfield, Centre, Blair, Bedford, Somerset, Westmoreland or Indiana County is left out, by the list's county and again by the county the agency's report covers. |
| Report links | The CCN comes from Intel's `agency_match` (name for matching, city, PA); a match of the other setting is not taken. The token is Intel's format with `s` from the sheet, `e` 90 days out and `r` the sheet's ref, at `/report/<token>/view` when Intel serves the web view. The Hub checks each link once, signed without `r`, so the check is never counted as an open. No confident match, or no report: the county report version of email 1. When the report names another county, that county is used in all three emails. |
| Opens | Intel's opens are read with the Marketing Manager's report views (Settings → Customer growth → Learn which agencies opened their report). An open counts only from two minutes after the person's first email; the owner is told of each agency's first open. |

## A request instead of the Growth page

Preparing a sequence signs each report link and each unsubscribe link with keys only the Hub server holds, and Growth needs the owner's
signed-in session. When the owner asks someone working for them (CareMetric staff with database access, or Claude Code) to do it, that
person queues a **request**: a row in `private.owner_sequence_requests` (no application role can write it) naming the owner, the send list
and its choices, and whether to approve it (`20261127200000_owner_sequence_requests.sql`, feature `platform.agents.owner-sequence-requests.v1`).

```sql
insert into private.owner_sequence_requests (requested_by, approve, payload)
values ('<the owner''s user id>', true, jsonb_build_object('name', 'Pennsylvania cold email, batch 1', 'campaign', 'pa-cold-email',
  'sendDates', jsonb_build_array('2026-12-01', '2026-12-04', '2026-12-09'), 'dailyLimit', 8, 'csv', '<the send list as text>'));
```

The Marketing Manager's next `growth.sequences` run (within five minutes, while **Send your own email sequences** is on) prepares it
exactly as the Growth page does: the same checks and left-out reasons, the same matching, links and copy. It saves the draft in the owner's
name and approves it when the request asked (the audit says `via: request`). The owner gets an alert saying it was approved or is ready for
review, with each row left out and why. A request is prepared only for an active CareMetric admin; one the database refuses (a person who
may not be emailed, a date that passed) fails with the reason and saves nothing.

## The AI team builds the next batch

Owner, November 27, 2026: "train my AI workforce on how to do this". Batch 2 was built by hand; from then on the Marketing Manager builds
each batch itself (`server/growth/sequence-batches.mjs`, `20261127220000_owner_sequence_batches.sql`, feature
`platform.agents.owner-sequence-batches.v1`), while Settings → Customer growth → **Build your next sequence batch** is on.

Once a week, on its `growth.sequences` run, it:

1. Asks the database for the agencies ready for a batch (`private.owner_sequence_batch_plan`). These are Pennsylvania roster agencies the
   roster graduated. Each one must pass every test below:
   - every roster entry is proprietary (CMS's control type);
   - it has one office (one street address);
   - it is outside Cambria County and its seven neighbors;
   - it has a domain of its own;
   - the Marketing Manager has never written to it;
   - it is not stopped (opted out, do-not-contact, or the guard above);
   - it is in no owner sequence, by domain or CCN;
   - it has a person whose work address the people step confirmed on that domain. The people step names owners from CMS, the NPI
     registry and the agency's own pages, then checks the address with the mail server or the verification service. Never a guessed
     address.

   The agencies with the most Medicare patients come first.
2. Leaves out an agency in any of these cases:
   - any of its CMS owners (Intel's `agency_facts`) is an organization rather than a person, which rules out chains, health systems,
     holding companies and private equity;
   - its website is on a page builder's host;
   - its person does not decide. Only an owner, a corporate officer, the president or CEO, the administrator or the executive director
     counts.
3. Writes the send list (refs `pa-b<N>-01`, the agency's CCN given so it is used as is). It queues the list as a request in the owner's
   name, "Pennsylvania cold email, batch N", and sets three dates:
   - the first Tuesday at least four days out and a week after the previous batch's first email;
   - that Friday;
   - the next Wednesday.

   At most 10 emails a day go out from it. The owner is told who is in it.
4. The request is then prepared within five minutes like any other ([A request instead of the Growth page](#a-request-instead-of-the-growth-page)),
   with every check again. It is approved only while **Approve the batches the AI team builds** is on; otherwise it waits on Growth.

The builder skips a week in four cases:
- a request is still waiting;
- it already built a batch in the last six days;
- no CareMetric admin has approved a sequence yet (the newest approver is the owner the batch is queued for);
- fewer than three agencies (or the batch size, if smaller) are ready.

**Agencies in each batch** sets the size (default 8). Building a batch sends nothing: **Send your own email sequences** sends it.

## Finding the owners' addresses with Hunter

A batch needs an owner or administrator whose address is confirmed. The Marketing Manager's people step names people from public records
but confirms few addresses: most agencies' mail servers refuse the Hub's cloud server (November 24, 2026: 15 checks, none confirmed), and no
verification service is in use. Built by hand, batch 2 found 8 of 10 owners with Hunter's Email Finder, which looks a person up by name
and domain and checks the address itself. So the Marketing Manager now asks Hunter too (`server/growth/hunter.mjs`,
`20261127230000_growth_hunter.sql`, feature `platform.agents.growth-hunter.v1`), while Settings → Customer growth → **Find owners' addresses
with Hunter** is on and `HUNTER_API_KEY` is set.

On each `growth.people` run (every half hour), before its usual work, it:
1. Asks the database for the agencies the weekly batch would take but for an address. These pass the same tests as a batch and have
   people named, but no confirmed address on their own domain, and nobody asked Hunter about them in the last 180 days. Those with the
   most Medicare patients come first.
2. Leaves out an agency the batch would leave out, before any lookup is reserved (`20261127233000_growth_hunter_screen.sql`): one whose
   only website is on a page builder's host, or whose CMS owners (Intel's `agency_facts`) are unknown or include an organization (a chain,
   a health system, a holding company, private equity). Without the feed nobody is looked up. Hunter's first queue held Crossroads
   Hospice, a national chain, third.
3. Picks each agency's person whose role decides most: an owner, officer, president or CEO, the authorized official the NPI registry
   names, the administrator or the executive director.
4. Reserves one lookup under **Most Hunter lookups a day** (default 5; Hunter charges a credit only when it finds an address, and its free
   plan has about 25 a month), then asks Hunter. At most two lookups a run.
5. Keeps an address only if all of these hold:
   - it is on the agency's own domain;
   - Hunter's own check calls it valid;
   - its score is 80 or more;
   - where the domain accepts every address, Hunter saw it published somewhere.

   Kept addresses are recorded as confirmed (`address_found = 'hunter'`) and wait for review: they are never permitted for the Marketing
   Manager's own cold email on their own, so the agency stays for your batch.

The next weekly batch then takes the agencies Hunter found addresses for. A refused key stops the lookups for that run and says so in
the task's result. The key goes in a header, never in a URL, a log or a result.

## The send list

A CSV, one row per person. Columns (header names are read loosely, in any order): `ref` (letters, digits, `-` or `_`; it is the report
link's reference and each link's `utm_term`), `email`, `first_name` (empty: "Hi there,"), `agency_display`, `agency_name_for_matching`,
`city`, `county` ("Erie" or "Erie County"), `setting` (`hha` or `hospice`), and optionally `state` (Pennsylvania only), `website` and
`ccn` (when given it is used as is). A row is left out, with the reason shown, for a missing or malformed field, another state, the
owner's home area, a repeated ref or address, the do-not-contact or suppression list, a person already in an approved sequence, or an
agency the Marketing Manager emailed in the last 90 days (by address, domain or CCN). At most 30 people a sequence.

## Changing the copy

A new batch with the same emails uses the same copy. Different words are a code change: add a template to `templates` in
`owner-sequence.mjs` with its test pinning each email, and check every product claim against Intel's code as the handoff did.

## Stopping

Stop one person or the whole sequence on Growth; turning the setting off holds every approved email where it is. An email the mail
service did not confirm is never sent again on its own: check SendGrid's activity for the address first.
