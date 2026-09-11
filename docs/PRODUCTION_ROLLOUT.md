# Production rollout record

This record separates verified production state from source-ready work and
owner-controlled prerequisites. A merged pull request is not labeled live
until the corresponding production deployment and public link have both been
checked.

## Central platform

### September 10 reconciliation

The audit verified Hub Railway deployment `8bcf9edd-f03e-49fc-b5a9-7f914119259d`
at `def580fed48550696ec676f6d0655d7e8054d73c`. Its actor mapper required
memberships, but production had not received the two September 8 migrations.
Both exact merged migrations have now been applied and their history versions
reconciled to the original filenames after checking SQL equality. The new
`20260910205232_expose_backend_contract.sql` migration is also deployed.
Anonymous and authenticated role checks return only API version `1`; an
unauthenticated actor request remains denied. A connected frontend build passed.

The frontend build gate and corrected CareBase authoring link are source
changes prepared after that deployed commit. They are not labeled deployed.
Production still has no tenants, cases, intake activation rows, verified TOTP
factors, federation issuers, or federated principals. The latest full portfolio
findings and source revisions are in [the architecture audit](PLATFORM_ARCHITECTURE_AUDIT.md).

The tables below retain the September 7 release evidence. The September 10
reconciliation above supersedes their Hub revision/migration status. Intel's
current source uses Express/Postgres, so its historical Base44 rollout row is
not evidence that the current authenticated backend has been deployed.

| Capability | Verified state |
| --- | --- |
| Support Hub | `kdeyarmin/caremetric-support-hub@3ac0722` is live at `https://support-hub-web-production.up.railway.app` with direct `/help` and `/learn` routes; no rendered link uses localhost. Production migration history and the repository are aligned through `20260907222641_gate_case_intake_and_add_idempotency.sql`. |
| Central contacts | The owner-designated values are `+18775212890` (displayed as `(877) 521-2890`) and `support@caremetric.ai`. The web portal is operational; email delivery is not verified because mailbox DNS is absent. |
| Product registry | CareMetric CareBase, CareMetric Breathe, PennSync, CareMetric EMR, CareMetric Go, and CareMetric Intel. |
| Shared learning | 80 imported public CareBase courses plus one customer-only onboarding course. Every registered product has all 81 governed placements; anonymous visitors see the same 80 public courses across 22 categories, including searchable metadata for 65 current video lessons. |
| Shared knowledge | 70 published CareBase articles plus the reviewed Support Hub core guidance. |
| Case operations | The first-party case/message queue, staff controls, RLS, atomic RPCs, tenant/product activation gate, and request-key replay protection are deployed and tested. Intake defaults off, and production has zero activation rows, tenants, cases, or retry records. A tenant/product can accept cases only after provisioning and an active, usable, verified-TOTP support writer exist. |
| Publication preview | The Hub contains a deterministic, credential-free DocStudio publication preview for a closed manifest/assets/snapshot package. It validates six-product targeting, immutable monotonic revisions, SHA-256 assets, captions/transcripts, safe text, placement changes, retirement, and reactivation without fetching, uploading, writing, or deleting anything. A reviewed first-party apply transport remains deliberately absent. |
| Video delivery | Metadata for 65 current lesson videos is searchable in the Hub and shared across all six products. The Hub has no copied media assets or public video bucket; playback continues through the authenticated CareBase course runtime until captions, checksums, and an entitlement-aware asset broker are approved. |
| Inbound channels | The central phone and email values are registered in one owner-controlled contact registry. Phone-call disposition and inbound-email ingestion are not connected yet; any future transport must write into the Hub rather than become a separate help-desk system of record. |
| Administration | `kdeyarmin@comcast.net` is the sole active, confirmed platform administrator; bootstrap provisioning is permanently closed. TOTP/AAL2 is enforced in the UI and database. The account currently has no verified factor and will be required to enroll at its next Hub sign-in before privileged data loads. |
| Customer data boundary | No learner progress, quiz results, certificates, patient data, tenant data, private media URL, HeyGen job credential, or application ticket database was copied into the catalog. |

## Application rollout

| Surface | Repository evidence | Production state |
| --- | --- | --- |
| CareMetric EMR | `kdeyarmin/CMbackup@9718b07` | Live at `https://caremetric.ai`; dashboard Help opens the Hub with `product=caremetric-emr` and a safe static route. Local support remains the rollback path. |
| CareMetric Breathe | `kdeyarmin/PennFit@0e2409c` plus rollout documentation at `c92b0b2` | Live at `https://cmbreathe.com`; admin support opens the Hub with `product=breathe`. Patient/tenant service contacts intentionally remain separate. |
| PennSite | `kdeyarmin/PennSite@f7aa91f` | Live at `https://penn.up.railway.app`; the site-wide Software Help Center opens the Hub while healthcare-service phone numbers remain distinct. |
| PennSync | `kdeyarmin/CareMetric-Pennsync@feca891` | Published through Base44 at `https://app.caremetricai.com`; the production bundle and public site contain the contextual launcher, permanent Hub origin, correct phone/email fallback, and exact production app/environment gates. Local Help remains the rollback path. A fresh authenticated Help-button click remains unverified, so this row is not yet marked fully Live. |
| CareMetric CareBase | `kdeyarmin/PennTrain@d332ddf` (PR #497), with ledger reconciliation at `dff5227` (PR #499) | The launcher is deployed successfully at the canonical `cmcarebase.com` / `caremetrictrain.com` Railway service and remains dark behind the default-off `support.central_hub` release flag. The shared course/help catalog is live in the Hub. Enroll the sole administrator in TOTP before the approved AAL2-protected flag change; do not bypass that release gate with direct SQL. |
| CareMetric Go | `kdeyarmin/CM-Go@a30a49c` | Source-ready for provider and patient menus with a central launcher and offline phone/email fallback. Native release is blocked by the placeholder EAS project ID, missing verified release credentials/workflow, and source/store version drift. |
| CareMetric Intel | `kdeyarmin/intel@c57776d` (PR #65) | The privacy-safe launcher, exact production/app identity gate, permanent Hub origin, always-available phone/email fallback, and deterministic guide inventory are merged and CI is green. `caremetricintel.com` remains healthy on its preceding release; the new launcher is source-ready but not published because the Base44 sandbox/bridge is returning server-side errors. Its product guide has not been auto-published without content review. |
| DocStudio | `kdeyarmin/DocStudio@d02d0a2` | A tested, PHI-free, hash-addressed export contract and exact six-product allowlist are merged. The Hub now has a read-only publication preview for that contract. It is not part of the current CareMetric EMR deployment; actual publishing remains blocked until the first-party apply and asset-ingest boundary is implemented and approved. |

## Deliberately excluded

| Repository | Disposition |
| --- | --- |
| `kdeyarmin/caremetric-carebase` | Historical, undeployed duplicate. The canonical deployment is `kdeyarmin/PennTrain`; do not integrate both. |
| `kdeyarmin/8x8` | Mock 8x8-themed prototype with no verified CareMetric identity, backend, CI, or production deployment; do not register as a Hub product. |
| App-Studio / KevAI | Product ownership and authoritative production deployment are unverified; do not mislabel it as CareMetric without an owner decision. |
| `kdeyarmin/pennsync`, `kdeyarmin/pennsync2` | Legacy PennSync repositories superseded by canonical `kdeyarmin/CareMetric-Pennsync`; do not create parallel launchers. |
| `kdeyarmin/presentations` | CareMetric Demo Studio is a login-gated sales-enablement prototype with no production deployment verified. Keep prospect, deal, lead-scoring, and personalized presentation data out of customer support and learning. |
| `kdeyarmin/RH-Trader`, `kdeyarmin/hillside` | Unrelated trading and ecommerce applications; outside the CareMetric support boundary. |

## Owner-controlled production prerequisites

1. At Name.com, create one CNAME: host `help`, target
   `sxz3x7r7.up.railway.app`. Railway already has
   `help.caremetric.ai` attached and requires no TXT record. Keep using the
   permanent Railway URL until DNS and TLS validate.
2. Configure a verified custom SMTP/send hook for Hub authentication before
   inviting external customers. Supabase's default mailer is not an
   organization-wide production mail service. Current public DNS has no MX,
   SPF, or DMARC record for `caremetric.ai`; configure the chosen mailbox and
   sending service's exact records before treating `support@caremetric.ai` as
   an operational inbound queue.
3. On the sole administrator's next Hub sign-in, complete the mandatory TOTP
   enrollment and then add a second verified authenticator from **Security**.
   AAL2 enforcement is already active in the UI and database; the minimal AAL1
   actor bootstrap remains available specifically so enrollment is recoverable.
4. Provision each customer tenant, product entitlement, and membership before
   expecting that customer to open or view cases. Anonymous case intake stays
   disabled.
5. The owner reports that all BAAs are signed. Separately reconcile the Hub's
   current Supabase organization plan (`pro`) with
   [Supabase's project-specific HIPAA/BAA requirements](https://supabase.com/docs/guides/security/hipaa-compliance),
   and verify the project is marked for HIPAA
   with MFA, PITR/restore, SSL enforcement, network restrictions, retention,
   and operational access review complete before allowing PHI-capable support.
   The portal is designated non-PHI and blocks submission when a requester
   acknowledges PHI, but it does not yet detect PHI pasted into free text.
6. Connect inbound email and phone dispositions to first-party Hub cases only
   after the chosen transport accounts, credentials, webhook signatures, and
   retention rules are approved. Email/telephone providers may transport
   messages, but must never become the case system of record.
7. Enable Supabase Auth leaked-password protection before inviting external
   users. The post-migration security advisor reports this single warning; the
   RLS-without-policy notices on `private` tables are informational and
   intentional because client roles have no access to that schema.

## 2026-09-07 release verification

- Pull request `#1` merged as `3ac0722c222c2912d96286b925c53bf769e370c1`
  only after both GitHub Actions jobs passed.
- CI run `34166434854` passed 137 Hub tests, 22 Help SDK tests, type checking,
  linting, both production builds, the full migration chain, and all 104 pgTAP
  database assertions (`15 + 17 + 72`).
- Railway deployment `76b04089-4d6c-4195-95b0-2d95dd131166` completed with
  `SUCCESS` for the exact merge commit.
- Migration `20260907222641_gate_case_intake_and_add_idempotency.sql` is present
  under the same version in both the repository and Supabase production
  history. Its production statement and repository file are byte-identical:
  27,272 bytes with SHA-256
  `a05602a56317c0b549d65eb39d26f455eb121aee86104bfa040be3ae024a3511`.
  The keyed create/reply RPCs and qualified thread RPC are present; anonymous
  thread execution is denied.
- Production remains safely dark for case intake: zero tenant rows, zero case
  rows, zero intake-activation rows, and zero request-key rows.
- A fresh public-browser check confirmed `/help` displays `(877) 521-2890` and
  `support@caremetric.ai`; `/learn` displays 80 published courses, 22 training
  categories, 65 included video lessons, and six registered products.
- All 80 rendered course links use `https://cmcarebase.com/app/courses/...`.
  The learning page contains no localhost, loopback, or insecure HTTP links.

## Release verification

For every application, verify all of the following before changing its row to
Live:

- the help action opens the permanent HTTPS Hub origin;
- the URL contains only an allowlisted product, static route/feature, sanitized
  version, locale, and environment;
- no user, tenant, organization, patient, record, query string, hash, free text,
  access token, or referrer is transmitted;
- `(877) 521-2890` and `support@caremetric.ai` are the software-support fallback;
- the application-owned local help path still works when its central-help flag
  is disabled;
- production CI, deployment health, and a real public click-through all pass.
