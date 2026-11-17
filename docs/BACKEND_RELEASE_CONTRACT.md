# Combined backend release contract

The connected Vite build and Node startup share `assertBackendContract` in
`src/lib/backendContract.ts`. API version 4 is stable for additive changes; the
integer alone does not establish compatibility. Both entry points require these
35 distinct feature names:

| Feature | Backend boundary |
| --- | --- |
| `learning.runtime.v1` | Existing catalog and learning delivery |
| `platform.admin.read.v1` | Current platform administrator reads |
| `app.sms.v1` | Current app-owned SMS sessions |
| `learning.sources.v1` | Immutable governed source snapshots |
| `platform.admin.command.v1` | Reviewed native command delegation |
| `learning.receipts.v1` | Prospective receipt and explicit identity mappings |
| `learning.authoring.v1` | Source-pinned native authoring intents and results |
| `knowledge.publications.v1` | Reviewed DocStudio imports, private staging, immutable commits, media and cleanup |
| `support.readiness.v1` | Current support access measurement and reviewed intake settings |
| `platform.admin.intel.v1` | Intel's isolated delegation audience and current administrator authorization |
| `learning.draft-editing.v1` | Reviewed native draft editing and review actions |
| `billing.portal.v1` | Current-session portal reservation, preview, dispatch and redacted outcome recovery |
| `support.customer-onboarding.v1` | Reviewed tenant and product onboarding settings |
| `learning.structure.v1` | Source-bound course structure edits |
| `support.customer-registration.v1` | Reviewed customer registration and membership |
| `billing.checkout.v1` | Governed native checkout commands |
| `learning.course-creation.v1` | Governed native course creation |
| `learning.credit-policy.v1` | Reviewed course credit policy commands |
| `learning.distribution.v1` | Governed course distribution and receipts |
| `learning.pennsync-source.v1` | PennSync source snapshots and native learning mapping |
| `learning.media.v1` | Governed course media uploads and delivery |
| `phone.registry.v1` | Central phone number and routing registry |
| `phone.accounts.v1` | Phone account and tenant assignments |
| `learning.sequence.v1` | Reviewed course sequence commands |
| `support.ai-assistance.v1` | Staff AI assistance and provider configuration gates |
| `support.ai-automation.v1` | Governed automated case assistance |
| `support.go-live-readiness.v1` | Current operational readiness checks |
| `support.ai-automation-server.v1` | Server automation worker boundaries |
| `platform.admin.advisors.v1` | SMS-authorized Healthcare Advisors administration reads |
| `support.ai-automation-failure-policy.v1` | Bounded automation retry and failure handling |
| `support.communications.v1` | Shared conversations, replies and channel configuration |
| `support.ai-usage.v1` | Private AI usage ledger and administrator summaries |
| `platform.admin.tenants.v1` | Administrator tenant and subscription records |
| `support.bulk-email.v1` | Governed bulk email preparation and delivery |
| `learning.catalog-authoring.v1` | Reviewed course unpublish and published-lesson corrections |

`20261117110100_app_command_audiences_contract.sql` declares `platform.admin.app-commands.v1` only after
`20261117110000_app_command_audiences.sql` has given Breathe and CareMetric Intel command audiences of their own
(`breathe.command`, `intel.command`) while keeping every existing audience, and the SMS, administrator-command and Intel
foundations are declared. It is optional: the Hub server reads it at boot and, until it is present, refuses those audiences and
hides Breathe's and Intel's change capabilities from the browser ([central access commands](CENTRAL_ADMIN_COMMANDS.md)).

`20261117130100_publication_import_window_contract.sql` declares `knowledge.publications.direct-storage.v1` only after
`20261117130000_publication_import_window.sql` has added `private.keep_publication_import_open` and the four-hour import window,
and `knowledge.publications.v1` is declared. It is optional: the Hub server reads it at boot and, while it is present, keeps an import
open as its parts arrive and sends a checked file straight to Storage through a one-time address the publication-media function signs,
then reads it back to hash it before recording it. Until then it streams files through that function as before
([publication imports](PUBLICATION_IMPORTS.md)). Deploy the publication-media function first.

`20261117140000_lesson_media_direct_storage_contract.sql` declares `learning.lesson-media.direct-storage.v1` once
`learning.runtime.v1` and `hub.authorize_learning_object` exist. It changes no schema: it records that the `app-media` function
signs one-time upload addresses (`upload-sign`), so deploy that function first. It is optional: while it is present the Hub sends
lesson media straight to the `hub-learning` bucket and reads it back to check it; until then it streams lesson media through
`app-media` as before ([central learning](CENTRAL_LEARNING.md)).

`20261117180100_work_recovery_contract.sql` declares `platform.agents.work-recovery.v1` once the growth diagnostics, creative review, ads,
address check, people finder, app growth, watchdog and hand-over features are declared, `private.creative_render_requeue`,
`private.ads_platform_refusals`, the three-argument `private.creative_data_counties` and `private.agent_watchdog_facts` are executable by
`hub_app_server` alone and require its connection, `private.creative_brief_pictured`, `private.growth_internal_address` and
`private.growth_event_intent` are closed to every role, and each change of the 2026-11-17 review is in place: a county counts as pictured
only while its snapshot still pictures it, only images blocked by the first image review (while the review is on) are rendered again,
the bounce guard counts hard bounces against at least 20 emails, why a check got no answer may be one of the STARTTLS reasons
(`tls_required`, `tls_failed`), the people finder's mail-server confirmation is recorded, an
opportunity's intent follows each activity event, a trial from the owner's or a CareMetric address is internal, and the watchdog reads
what the team lost. Each test fails closed. The Hub server renders the blocked images again and reads the platforms' refusals only when
the feature is declared ([AI workforce review, November 17](AI_WORKFORCE_REVIEW_2026-11-17.md)).

`20261117190100_growth_priority_contract.sql` declares `platform.agents.growth-priority.v1` once the work recovery, report views, account
brief, learning, address check and colleague features are declared, the three-argument `private.growth_defer_action`,
`private.growth_quiet_candidates`, `private.sales_growth_context`, the replaced `private.agent_actions_ready` and
`private.growth_learning_facts` are executable by `hub_app_server` alone and require its connection, the band, score, send-hours,
report-open and context-reading helpers are closed to every role, the six stage 2 settings have rows, and each change of stage 2 is in
place: the send claim holds cold email outside the owner's send hours (`outside_hours`), the ready queue reads "Send to the best prospects
first", the pipeline snapshot carries each opportunity's band and first form, a brief needs an agency that can be emailed, a first report
open brings the second email forward, and the memo's facts count report opens per arm and the reader's weaknesses. Each test fails
closed. The Hub server passes a deferral's reason, lists quiet prospects, writes the short first email and gives the Sales Executive its
context only when the feature is declared ([AI workforce review, November 17](AI_WORKFORCE_REVIEW_2026-11-17.md), stage 2).

`20261117210100_growth_reach_contract.sql` declares `platform.agents.growth-reach.v1` once the growth priority, roster and learning
features are declared, `private.growth_roster_site_next`, `private.growth_roster_site_record`, `private.growth_live_eval_state`,
`private.growth_live_eval_record` and `private.growth_live_evaluation_latest` are executable by `hub_app_server` alone and require its
connection, `private.growth_live_eval_cases` has row level security and is closed to every role, the four stage 3 settings have rows, a
site the web search found graduates through the lookups' own `private.growth_roster_resolved`, `hub.growth_roster` carries the
suggestions, and the `growth.sites` and `growth.evaluate_live` schedules exist. Each test fails closed. The Hub server searches the web
for roster agencies, runs the live evaluation and shows its result in the scorecard only when the feature is declared
([AI workforce review, November 17](AI_WORKFORCE_REVIEW_2026-11-17.md), stage 3).

`20261117230100_trial_path_contract.sql` declares `platform.agents.trial-path.v1` once the customer email, trial card and Sales
Executive features are declared, `private.growth_trial_cards` has row level security and is closed to every role, the
`growth_trial_card_seen` trigger on `private.billing_trial_cards` exists, `private.growth_capture_billing` no longer counts an Intel
trial without its card and queues a counted trial that ended unpaid (`billing:trial_lost:`, the outbox accepting `churned`), the action
check, the send ledger's template and period checks and `private.agent_lifecycle_json` accept `card_reminder`, `midtrial_nudge` and
`value_followup`, the facts carry `cardConfirmedAt` and `firstValueAt` and stay executable by no role, `private.agent_lifecycle_defer`
is executable by `hub_app_server` alone and requires its connection, `private.sales_handoff` includes the `trial` stage and
`private.growth_app_event` accepts Intel's milestones. Each test fails closed. The Hub server plans the trial path's emails, reads a
trial's card and activity, and lets a refused customer email wait only when the feature is declared
([team review, November 17](AI_WORKFORCE_REVIEW_2026-11-17_TEAM.md), stage 4).

`20261102120100_agent_control_plane_contract.sql` declares `platform.agents.v1` only after
verifying that the six AI team tables keep row level security and grant nothing to any
browser, service or server role, that every server operation is a security definer with a
pinned empty search path executable by `hub_app_server` alone, that its helpers are
executable by no role, and that each owner operation authorizes the current administrator
session (reads) or command session (changes) itself. The feature is declared ahead of the Hub
build that will require it, so the migrations can be applied before that build ships.

`20261102130100_agent_probes_contract.sql` declares `platform.agents.probes.v1` only after
`platform.agents.v1` is declared and the probe state table keeps row level security with no
privilege for any browser, service or server role, and `private.agent_probe_record(...)`
stays a security definer with a pinned empty search path executable by `hub_app_server`
alone. Like the feature above it is declared ahead of any build that requires it.

`20261102140100_agent_brief_contract.sql` declares `platform.agents.brief.v1` only after
`platform.agents.v1`, `platform.agents.probes.v1` and `billing.platform.v1` are declared and
`private.agent_brief_facts()` is a security definer with a pinned empty search path executable by
`hub_app_server` alone.

`20261102150100_agent_seo_contract.sql` declares `platform.agents.seo.v1` only after
`platform.agents.v1` is declared and the SEO Analyst agent and its weekly schedule exist.

`20261102160100_agent_concierge_contract.sql` declares `platform.agents.concierge.v1` only after
`platform.agents.v1` and `support.communications.v1` are declared, the Support Concierge agent and its
sweep schedule exist, and `private.agent_concierge_pending(...)`, `private.agent_communication_snapshot(...)`
and `private.agent_notification_count(...)` are security definers with a pinned empty search path
executable by `hub_app_server` alone. The Hub server registers the Concierge's handlers only when the
feature is declared.

`20261102170100_agent_accounts_contract.sql` declares `platform.agents.accounts.v1` only after
`platform.agents.v1` and `billing.platform.v1` are declared, the Account Manager agent and its weekly
schedule exist, `private.agent_accounts_snapshot(...)` is a security definer with a pinned empty search
path executable by `hub_app_server` alone, and its two helpers
(`private.agent_accounts_json(...)` and `private.agent_subscription_facts(...)`) pin an empty search path
and are executable by no application role. The Hub server registers the Account Manager's handler only
when the feature is declared.

`20261102180100_agent_hardening_contract.sql` declares `platform.agents.hardening.v1` only after
`platform.agents.v1`, `platform.agents.probes.v1` and `platform.agents.brief.v1` are declared and every AI team
table, operation (the earlier signatures and the new fenced ones), helper and owner operation still has its
boundary: tables closed to every role with row level security on, operations security definers executable by
`hub_app_server` alone, helpers executable by no role, owner operations behind the administrator session, and
a pinned empty search path on all of them. Each test fails closed, so a function whose `search_path` setting
was reset (which leaves it null) is refused. The Hub server uses the fenced operations only when the feature is
declared.

`20261103120100_lead_desk_contract.sql` declares `support.leads.v1` only after `support.communications.v1` is
declared and the lead desk keeps its boundary: `private.leads` exists with row level security and grants nothing to any
browser, service or server role; the conversation table's source check accepts `carebase.web`, `intel.web` and
`advisors.web`; `private.lead_intake(text,jsonb)` and `private.lead_retention(integer)` (which deletes leads and website
conversations twelve months on) are security definers with a pinned empty search path, executable by `hub_app_server`
alone and calling `private.require_hub_app_server()`; their helpers (`private.lead_text`, `private.lead_instant`,
`private.lead_json`, `private.lead_record`, `private.lead_retention_batch`) pin an empty search path and are executable
by no application role; and `hub.list_leads(...)` authorizes the administrator session and
`hub.update_lead_status(...)` the command session themselves. Every test fails closed. The Hub server answers
`POST /api/leads` and runs lead retention only when the feature is declared (read at boot);
`src/lib/backendContract.ts` does not require it, so the migrations can be applied before or after the build that uses
them. See [LEAD_INTAKE.md](LEAD_INTAKE.md).

`20261103130100_agent_growth_contract.sql` declares `platform.agents.growth.v1` only after `platform.agents.v1`,
`platform.agents.probes.v1` and `support.leads.v1` are declared and the Growth Manager keeps its boundary: `private.leads`
still has row level security, grants nothing to any browser, service or server role and has its `growth_seen_at` column;
`private.agent_growth_pending`, `agent_growth_lead`, `agent_growth_mark_seen`, `agent_growth_unanswered`,
`agent_growth_facts`, `agent_lead_probe_seen` and the conversation snapshot they extend are security definers with a pinned
empty search path, executable by `hub_app_server` alone and calling `private.require_hub_app_server()`; their helpers pin an
empty search path and are executable by no application role; and the Growth Manager, its three schedules and the Platform
Engineer's lead form check exist. Every test fails closed. The Hub server registers the Growth Manager's handlers only when the
feature is declared (read at boot); `src/lib/backendContract.ts` does not require it. See [AI_TEAM.md](AI_TEAM.md).

`20261103140100_agent_lifecycle_contract.sql` declares `platform.agents.lifecycle.v1` only after
`platform.agents.accounts.v1`, `platform.agents.hardening.v1` and `support.bulk-email.v1` are declared, the
customer email ledger keeps row level security with no privilege for any browser, service or server role, the
`email.send` action kind has its shape check and its once-per-period unique index, the three new operations
(`private.agent_lifecycle_snapshot(...)`, `private.agent_lifecycle_begin_send(...)`,
`private.agent_lifecycle_finish_send(...)`) and the two it replaced (`private.agent_action_propose(...)`, which must
carry the per-template rule, and `private.email_unsubscribe(...)`) are security definers with a pinned empty search
path executable by `hub_app_server` alone, the facts helper is executable by no role, and the Account Manager has its
`auto_send_templates` setting and its daily customer email schedule. Each test fails closed. The Hub server registers
the customer email handler and executor only when the feature is declared.

`20261103150100_agent_content_contract.sql` declares `platform.agents.content.v1` only after `platform.agents.v1`,
`platform.agents.hardening.v1`, `knowledge.publications.v1` and `support.communications.v1` are declared, the
`content.publish` action kind (aimed at a `content_item`) has its shape check and its once-per-address and
once-per-topic unique indexes, `private.agent_content_state(...)` and `private.agent_content_publish(...)` are
security definers with a pinned empty search path executable by `hub_app_server` alone (publishing must refuse an
action the owner did not decide and author as the AI assistant profile, which must exist), and the Content Marketer
has its settings and its two daily schedules. Each test fails closed. The Hub server registers the Content Marketer's
handlers only when the feature is declared and a model key is set, and its publish executor only when the feature is
declared.

`20261104220100_agent_autonomy_contract.sql` declares `platform.agents.autonomy.v1` only after `platform.agents.v1`,
`platform.agents.hardening.v1` and `platform.agents.lifecycle.v1` are declared, `private.agent_autonomy_steps` has row
level security and no privilege for any browser, service or server role, `private.agent_autonomy_due()`,
`private.agent_autonomy_graduate(text)` and `private.agent_autonomy_announced(text, timestamptz)` are security definers with a pinned empty search path executable by
`hub_app_server` alone, `hub.get_agent_autonomy()` and `hub.set_agent_autonomy_step(...)` authorize the owner's session
(a change needs a current administrator session) and are executable by signed-in sessions only, the three internal
helpers are executable by no role, and the four steps and the Chief of Staff's schedule, every 3600 seconds, exist. Each test fails
closed. The Hub server registers the hourly task only when the feature is declared, and the Team screen leaves the
autonomy panel out when the database has no steps.

`20261105120100_concierge_answers_contract.sql` declares `platform.agents.concierge-autosend.v1` only after
`platform.agents.concierge.v1`, `platform.agents.hardening.v1`, `support.communications.v1` and `platform.agents.autonomy.v1`
are declared, `communication.answer` is an allowed action kind with a shape check that admits only cited drafted answers with no
identifiers, `private.agent_answer_begin(...)` is a security definer with a pinned empty search path executable by
`hub_app_server` alone that re-checks the Concierge's trust for an answer nobody approved and authors the message as the AI
assistant, and that profile exists. Each test fails closed. The Hub server proposes answers and registers their executor only
when the feature is declared.

`20261105130100_content_autopublish_contract.sql` declares `platform.agents.content-autopublish.v1` only after
`platform.agents.content.v1`, `platform.agents.hardening.v1` and `platform.agents.autonomy.v1` are declared and
`private.agent_content_publish(...)` is still a security definer with a pinned empty search path executable by `hub_app_server`
alone that authors as the AI assistant and publishes an article nobody approved only after re-checking that the Content
Marketer is trusted with `content.publish`. Each test fails closed. The Hub server's publish executor leaves an automatically
approved article to the database only when the feature is declared.

`20261105150100_growth_autonomy_contract.sql` declares `platform.agents.growth-autonomy.v1` only after
`platform.agents.customer-growth.v1`, `platform.agents.hardening.v1` and `platform.agents.autonomy.v1` are declared, a contact
found online is checked to be a role address, the qualification rules are closed to every role with one active set, the contact
finder, qualification, proposing and claiming operations are security definers with a pinned empty search path executable by
`hub_app_server` alone, proposing approves on its own only for a class the owner handed over, claiming re-checks that hand-over
with the agent row held and keeps the ten-a-day and once-per-business cold email caps, a product policy no longer overwrites an
agent's list, and the two steps and the daily evaluation schedule exist. Each test fails closed. The Hub server registers the
contact finder, qualification and evaluation only when the feature is declared.

`20261116020100_billing_trial_cards_contract.sql` declares `billing.trial-cards.v1` only after `billing.platform.v1` is declared,
`private.billing_trial_cards` exists with row-level security and is closed to every role, the Hub server included, and
`private.billing_trial_card_record` and `private.billing_trial_card_confirmed` are security definers with a pinned empty search path
that call `private.require_hub_app_server()` and are executable by `hub_app_server` alone. Each test fails closed. The Hub server keeps
Stripe's trial card answers in the table, and reads them while Stripe cannot be reached, only when the feature is declared.

`20261115200100_autonomy_handover_contract.sql` declares `platform.agents.autonomy-handover.v1` only after the autonomy, growth
autonomy, learning memo, people finder, founder post, paid ads and watchdog features are declared, the four steps
(`named_contacts`, `learning_memo`, `ad_campaigns`, `founder_posts`) exist requiring it with exactly their values, the campaign and
founder post checks keep their agent and target rules while the `agent_actions_handover_guard` trigger admits an automatic approval
of those kinds only while the matching step is automatic, `private.agent_action_trusted`, `private.ads_launch_reserve`,
`private.ads_launch_release`, `private.growth_person_address`, `private.growth_learning_propose` and `private.social_schedule` are
security definers with a pinned empty search path executable by `hub_app_server` alone, the launch reservations are closed to every
role, a reservation reads the owner's monthly number and daily ad-set limit, a named person's address is permitted on its own only
under the hand-over and never past an unsubscribe or an opt-out, a memo is used on its own only under the hand-over, and a founder
post handed back keeps its approval. Each test fails closed. Declaring it changes nothing by itself: the steps ship held. The Hub
server launches campaigns live and publishes automatically approved founder posts only when the feature is declared.

`20261116130100_creative_review_contract.sql` declares `platform.agents.creative-review.v1` only after the settings, Creative Director,
data creative and roster features are declared, the `creative.vision_review` and `creative.vision_min_score` settings exist, and the
three-argument `private.creative_data_counties` is executable by `hub_app_server` alone, requires the Hub server connection, keeps a county
out for 56 days after it is pictured and reports the setting it was pictured with last. Each test fails closed. The Hub server picks
counties from Intel's list of the roster's states only when the feature is declared, and otherwise from the roster's own counties as before.

`20261116120100_growth_report_views_contract.sql` declares `platform.agents.growth-report-views.v1` only after the settings, growth autonomy
and roster features are declared, the `growth.report_views` setting exists, an activity event may be `report_viewed`, the read cursor has row
level security and is closed to every role, `private.growth_report_views_cursor` and `private.growth_report_views_record` are executable by
`hub_app_server` alone and require the Hub server connection, an open counts only two minutes or more after the opportunity's first email,
and the Marketing Manager's `growth.views` task is scheduled. Each test fails closed. The Hub server reads opens and shapes second emails by
them only when the feature is declared.

`20261116110100_growth_brief_contract.sql` declares `platform.agents.growth-brief.v1` only after the settings, growth autonomy, roster and
research features are declared, the five settings exist (`growth.account_brief`, `growth.brief_per_day`, `growth.brief_cents`,
`growth.quality_writer`, `growth.draft_critic`), `private.growth_briefs` and `private.growth_brief_log` have row level security and are
closed to every role, `private.growth_brief_next`, `private.growth_brief_save` and `private.growth_brief_writer` are executable by
`hub_app_server` alone and require the Hub server connection, the writer's reader returns only a brief's writer part and never its research
part, `hub.growth_brief` needs a signed-in owner, and the Marketing Manager's `growth.brief` task is scheduled. Each test fails closed. The
Hub server writes briefs, drafts from them and shows them on Growth only when the feature is declared.

`20261116100100_growth_address_check_contract.sql` declares `platform.agents.growth-address-check.v1` only after the settings,
growth autonomy, people finder and colleagues features are declared, the settings `growth.presend_check` (text) and
`growth.bounce_guard_percent` (number) exist, the send guard table has row level security and is closed to every role,
`private.growth_send_hold`, `private.growth_draft_hold`, `private.growth_mailbox_candidates`, `private.growth_mailbox_record` and
`private.growth_send_guard_state` are executable by `hub_app_server` alone and require the Hub server connection, their helpers
(`growth_presend_mode`, `growth_mailbox_tries`, `growth_bounce_guard`, `growth_hold_for`) are closed to every role,
`hub.growth_send_guard` and `hub.growth_send_guard_resume` need a signed-in owner, contacts may be `undeliverable` while the send
claim still writes only to permitted contacts, the guard counts cold email that bounced for good, and the Marketing Manager's
`growth.verify` task is scheduled. Each test fails closed. The Hub server checks addresses, holds drafts and sends, and shows the
Send guard only when the feature is declared ([Customer growth](CUSTOMER_GROWTH.md#checking-an-address-before-the-first-email-and-the-bounce-guard)).

`20261117170100_weekly_strategist_contract.sql` declares `platform.agents.strategist.v1` only after the settings, Monday scorecard,
address check and account brief features are declared, the `agents.strategist` setting is a flag, `private.agent_strategy_notes` has
row level security and is closed to every role, the funnel helper `private.growth_strategy_facts_json` is closed to every role,
`private.growth_strategy_facts`, `private.agent_strategy_save` and `private.agent_strategy_note` are security definers with a pinned empty
search path executable by `hub_app_server` alone that require the Hub server connection, the funnel reads Intel only, excludes internal
organizations and counts a bounce as hard only once the address is suppressed, and the Chief of Staff's `strategy.weekly` task is
scheduled before `scorecard.weekly`. Each test fails closed. The Hub server writes the week's note, and the scorecard opens with it, only
when the feature is declared ([Monday scorecard](MONDAY_SCORECARD.md#the-weeks-constraint-the-weekly-strategist)).

`20261117160100_growth_diagnostics_contract.sql` declares `platform.agents.growth-diagnostics.v1` only after the address check and
account brief features are declared, contacts hold `mailbox_reason` under a check of the known reasons, the two- and three-argument
`private.growth_mailbox_record` and `private.growth_review_record` are security definers with a pinned empty search path executable by
`hub_app_server` alone that require the Hub server connection, the three-argument record calls the unchanged two-argument one (which
still makes a missing mailbox undeliverable), `private.growth_message_reviews` has row level security and is closed to every role, its
read check `private.growth_review_read_ok` is closed to every role, and the review record runs it. Each test fails closed. The Hub server
records why an address check got no answer and the reader's review of each first email only when the feature is declared
([Customer growth](CUSTOMER_GROWTH.md#checking-an-address-before-the-first-email-and-the-bounce-guard)).

`20261106220100_learning_media_import_contract.sql` declares `learning.media-import.v1` only after `learning.runtime.v1`,
`learning.media.v1` and `app.sms.v1` are declared, the staged-import table exists with row level security and is closed to every
browser, service and server role, the seven import operations are security definers with a pinned empty search path executable by
`hub_app_server` alone, each enters through a helper that requires the Hub server connection, a verified Hub SMS session and
shared-course editor authority, approval goes through `hub.register_learning_media` and attachment through
`hub.save_learning_draft`, the helpers stay internal, and the SQL PennSync lesson identity matches the conversion's on a fixed
vector. Each test fails closed. The Hub server answers the bulk media import route only when the feature is declared
([MEDIA_IMPORT.md](MEDIA_IMPORT.md)).

`20261105140100_agent_offers_contract.sql` declares `platform.agents.offers.v1` only after `platform.agents.v1`,
`platform.agents.hardening.v1`, `platform.agents.lifecycle.v1`, `platform.agents.autonomy.v1` and `billing.platform.v1` are
declared, the offer menu and the record of offers exist with row level security and are closed to every browser, service and
server role, the once-per-account index exists, `offer.apply` is an allowed action kind with a shape check aimed at a billing
account, the four server operations are security definers with a pinned empty search path executable by `hub_app_server` alone
(the one that makes an offer re-checks the Account Manager's trust, holding its row, holds the menu row while it counts the cap and
re-checks the offer's window; the one that records a coupon offer's request keeps the first request recorded), an offer whose action
ends unsettled is settled by the `agent_offer_settle_on_completion` trigger from how the action ended, the three owner operations
authorize the owner's session (changes need a current administrator session) and are executable by signed-in sessions only, the six
helpers are executable by no role, and the Account Manager's daily schedule exists. Each
test fails closed. The Hub server registers the daily run and the offer executor only when the feature is declared, and the Team
screen leaves the offer menu out when the database does not have it.

The table above is not exhaustive:
later features such as the `billing.*` and `customer.self-service.v1` boundaries are declared
by their own migrations and listed in `src/lib/backendContract.ts`. See [AI_TEAM.md](AI_TEAM.md).

`20261022210000_retire_docstudio.sql` removes the retired DocStudio tables,
functions and triggers after PR #85 removed their application callers. It removes
only `knowledge.docstudio.v1` from the latest 36-feature declaration, preserving
API version 4, all 35 features above and the invoker-only RPC permissions. The
shared publication tables/functions, `source_system: "docstudio"` provenance,
`publication-media` transport and `hub-publications` bucket are retained. The
separate deployed `docstudio-media` function and empty `hub-docstudio` bucket
require their own cleanup; this migration does not delete Storage buckets.

Apply the reviewed, ordered migration chain before deploying the matching image.
The CLI-generated `20260911190819_combined_authoring_publication_support_contract.sql`
preserves the existing six features and fails before declaration if any required
new SQL endpoint/table is absent. Intel additionally requires the validated
`app_delegations_audience_check` constraint to contain its exact `intel` audience;
it reuses the current SMS administrator procedure, not a new role grant.

The contract RPC remains invoker-only public release metadata. It grants no
actor access, creates no identity mapping, and enables no tenant intake. The earlier
six-, ten- and eleven-feature API 4 responses are
incompatible with this release. Later additive features remain compatible when
all required names are present and unique.

`20260911192238_learning_draft_editing_contract.sql` requires the actual draft
editing actions. The later CLI-generated
`20260911195910_billing_portal_backend_contract.sql` preserves all eleven features
and requires the portal intent table, current-session authorization, guarded
reservation/preview/claim/result/resume functions and the closed action enum used
by the intent table. Native capabilities and provider configuration remain separate
runtime checks; the declaration never creates a Stripe session.

`supabase/schema.sql` is a consolidated reference, not a migration to reapply to
production. Its appended source follows the ordered feature migrations, including
Go, authoring intents, support readiness, the governed source credential guard,
Intel, draft editing, portal intents and their declarations. Production changes
use migration history only.

SQL compatibility does not attest that a native application or Edge transport is
deployed, configured or healthy. Verify native capabilities, fixed mappings,
revocation behavior, the `publication-media` transport and its private bucket,
negative authorization cases, and the final deployed image separately. The
[publication requirements](PUBLICATION_IMPORTS.md) retain the conservative
25 MiB application video cap until project/runtime capacity is verified. A
feature declaration does not raise that cap or publish content.

CI exercises the actual declaration SQL in disposable PostgreSQL after renaming
a required endpoint or table, replacing the Intel audience check, and removing
the foundational feature metadata. Each attempt must fail without changing the
previous metadata. All synthetic schema changes are rolled back. The same test
accepts the complete contract through the actual shared startup assertion.
The portal gate additionally rejects missing reservation/result functions or its
intent table, altered action enum/nullability/validator and missing foundation
metadata. Historical declaration replays recreate the retired runtime only inside
rolled-back disposable transactions, then replay its retirement to restore the
exact current 35-feature contract. Missing any required feature prevents the
matching image from starting.
