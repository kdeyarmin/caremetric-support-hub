# Production rollout record

This record separates verified production state from source-ready work and
owner-controlled prerequisites. A merged pull request is not labeled live
until the corresponding production deployment and public link have both been
checked.

## Central platform

| Capability | Verified state |
| --- | --- |
| Support Hub | `kdeyarmin/caremetric-support-hub` is live at `https://support-hub-web-production.up.railway.app` with direct `/help` and `/learn` routes; no localhost redirect is used. |
| Central contacts | The owner-designated values are `+18775212890` (displayed as `(877) 521-2890`) and `support@caremetric.ai`. The web portal is operational; email delivery is not verified because mailbox DNS is absent. |
| Product registry | CareMetric CareBase, CareMetric Breathe, PennSync, CareMetric EMR, CareMetric Go, and CareMetric Intel. |
| Shared learning | 80 imported public CareBase courses plus one customer-only onboarding course. Every registered product has all 81 governed placements; anonymous visitors see the same 80 public courses across 22 categories, including searchable metadata for 65 current video lessons. |
| Shared knowledge | 70 published CareBase articles plus the reviewed Support Hub core guidance. |
| Administration | `kdeyarmin@comcast.net` is the sole active, confirmed platform administrator; bootstrap provisioning is permanently closed. |
| Customer data boundary | No learner progress, quiz results, certificates, patient data, tenant data, private media URL, HeyGen job credential, or application ticket database was copied into the catalog. |

## Application rollout

| Surface | Repository evidence | Production state |
| --- | --- | --- |
| CareMetric EMR | `kdeyarmin/CMbackup@9718b07` | Live at `https://caremetric.ai`; dashboard Help opens the Hub with `product=caremetric-emr` and a safe static route. Local support remains the rollback path. |
| CareMetric Breathe | `kdeyarmin/PennFit@0e2409c` plus rollout documentation at `c92b0b2` | Live at `https://cmbreathe.com`; admin support opens the Hub with `product=breathe`. Patient/tenant service contacts intentionally remain separate. |
| PennSite | `kdeyarmin/PennSite@f7aa91f` | Live at `https://penn.up.railway.app`; the site-wide Software Help Center opens the Hub while healthcare-service phone numbers remain distinct. |
| PennSync | `kdeyarmin/CareMetric-Pennsync@feca891` | Published through Base44 at `https://app.caremetricai.com`; the production bundle and public site contain the contextual launcher, permanent Hub origin, correct phone/email fallback, and exact production app/environment gates. Local Help remains the rollback path. A fresh authenticated Help-button click remains unverified, so this row is not yet marked fully Live. |
| CareMetric CareBase | Pull request `kdeyarmin/PennTrain#497` | Shared course/help catalog is live in the Hub; CareBase launcher production rollout is in progress. `cmcarebase.com` and `caremetrictrain.com` are the same canonical PennTrain deployment. |
| CareMetric Go | `kdeyarmin/CM-Go@a30a49c` | Source-ready for provider and patient menus with a central launcher and offline phone/email fallback. Native release is blocked by the placeholder EAS project ID, missing verified release credentials/workflow, and source/store version drift. |
| CareMetric Intel | `kdeyarmin/intel` | Registered as a pilot product with the governed shared course catalog and core safety guidance. Production deployment and central-launcher audit are in progress; its product-specific guide has not been auto-published without review. |
| DocStudio | `kdeyarmin/DocStudio@d02d0a2` | A tested, PHI-free, hash-addressed export contract and exact six-product allowlist are merged. It is not part of the current CareMetric EMR deployment; publishing remains blocked until the first-party Hub importer and asset-ingest boundary exist. |

## Deliberately excluded

| Repository | Disposition |
| --- | --- |
| `kdeyarmin/caremetric-carebase` | Historical, undeployed duplicate. The canonical deployment is `kdeyarmin/PennTrain`; do not integrate both. |
| `kdeyarmin/8x8` | Mock 8x8-themed prototype with no verified CareMetric identity, backend, CI, or production deployment; do not register as a Hub product. |
| App-Studio / KevAI | Product ownership and authoritative production deployment are unverified; do not mislabel it as CareMetric without an owner decision. |
| `kdeyarmin/pennsync`, `kdeyarmin/pennsync2` | Legacy PennSync repositories superseded by canonical `kdeyarmin/CareMetric-Pennsync`; do not create parallel launchers. |
| `kdeyarmin/presentations` | CareMetric Demo Studio is an unpublished, login-gated sales-enablement prototype. Keep prospect, deal, lead-scoring, and personalized presentation data out of customer support and learning. |
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
3. Enroll the sole administrator in TOTP MFA before requiring AAL2; enforcing
   AAL2 first would lock out the only administrator.
4. Provision each customer tenant, product entitlement, and membership before
   expecting that customer to open or view cases. Anonymous case intake stays
   disabled.
5. Verify the remaining High Compliance controls (including applicable
   project add-ons, PITR/restore, SSL/network restrictions, retention, and
   operational access review) before allowing PHI-capable support. The current
   intake continues to reject PHI.
6. Connect inbound email and phone dispositions to first-party Hub cases only
   after the chosen transport accounts, credentials, webhook signatures, and
   retention rules are approved. Email/telephone providers may transport
   messages, but must never become the case system of record.

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
