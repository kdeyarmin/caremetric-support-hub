# Application integration contract

## Launcher

Build the framework-neutral package from `packages/help-sdk` with
`npm run pack:sdk`, then install the resulting versioned tarball in each private
application. This keeps the integration reproducible without introducing a
third-party help-desk dependency.

```ts
import { openHelp } from "@caremetric/help-sdk";

const supportRoutes = {
  memberInvitations: "/members/invite"
} as const;

openHelp({
  routeAllowlist: Object.values(supportRoutes),
  featureAllowlist: ["member-invitations"],
  context: {
    product: "breathe",
    route: supportRoutes.memberInvitations,
    feature: "member-invitations",
    appVersion: APP_VERSION,
    locale: "en-US",
    environment: "production"
  }
});
```

Production callers should omit `baseUrl`. The package defaults to
`https://support-hub-web-production.up.railway.app`, which prevents the host
application's `localhost` origin from leaking into the help link. Only an
explicit staging or development Hub should override it.

The launcher deliberately has no parameter for user, tenant, email, patient, record, ticket body, diagnostic payload, access token, or arbitrary metadata.

The SDK strips query strings and fragments defensively, but includes a route or
feature only when it exactly matches the caller's compile-time allowlist. Map
the active screen to a static template such as `/members/:id`; never pass
`window.location.pathname` directly. Prefer `buildHelpUrl(...)` for an anchor
or during server rendering; call `openHelp(...)` only from a browser
interaction.

## Identity exchange

URL context is not authorization. Each product backend will later mint a five-minute asymmetric JWS for the Hub context-exchange endpoint. The Hub validates the issuer, audience, algorithm, key ID, signature, expiry, origin, and one-time nonce. It then resolves verified private identity/tenant mappings and rechecks the current Hub membership.

## Context resolution

The planned read contract is:

```http
GET /api/v1/help/resolve?product=breathe&route=/members/invite&feature=member-invitations&locale=en-US&app_version=3.8.2
```

Resolution order:

1. Product overlay + locale + compatible app version.
2. Product overlay + language fallback.
3. Shared core + locale.
4. Shared core + default locale.

Responses return sanitized HTML/plain text and stable `content_key` values. Applications never execute remote MDX and never embed a HeyGen provider URL.

## Rollout pattern

Every product integration must have:

- A product slug and route-to-feature map.
- A feature flag.
- A temporary local-help fallback.
- An observable failure state.
- A rollback that does not require changing the Support Hub database.

## Central learning

SDK 0.4.0 adds `buildCourseEditorUrl()` and `buildMyLearningUrl()` alongside
`buildLearningUrl({ product })`. Course creation and delivery belong in the Hub.
Publishing a migrated course switches catalog and contextual-help links to its
Hub runtime without changing its catalog ID. The implementation and transfer
requirements are in [CENTRAL_LEARNING.md](CENTRAL_LEARNING.md). Consuming apps
must preserve historical access until identities, content, and records have
been reconciled. No app should provision a new HeyGen key for this runtime.

### Production catalog before central runtime deployment

The production Hub publishes non-PHI course metadata at
`https://support-hub-web-production.up.railway.app/learn`. Applications may
add `?product=<canonical-product-slug>` to retain product context. Each course
launch is resolved against the verified `https://cmcarebase.com` origin using
a trusted relative `/app/courses/<course-id>` path.

Only titles, approved summaries, categories, duration, video counts, and course
launch paths are shared. Enrollments, assignments, progress, quiz results,
attestations, certificates, employee data, and organization data stay in
CareMetric CareBase.
