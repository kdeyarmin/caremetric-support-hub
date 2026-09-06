# Application integration contract

## Launcher

Install or vendor the framework-neutral package from `packages/help-sdk`.

```ts
import { openHelp } from "@caremetric/help-sdk";

openHelp({
  baseUrl: "https://help.caremetric.ai",
  context: {
    product: "pennfit",
    route: window.location.pathname,
    feature: "member-invitations",
    appVersion: APP_VERSION,
    locale: "en-US",
    environment: "production"
  }
});
```

The launcher deliberately has no parameter for user, tenant, email, patient, record, ticket body, diagnostic payload, access token, or arbitrary metadata.

Before calling it, strip query strings and fragments from any route. Prefer a stable route template such as `/members/:id` rather than a concrete identifier-bearing URL.

## Identity exchange

URL context is not authorization. Each product backend will later mint a five-minute asymmetric JWS for the Hub context-exchange endpoint. The Hub validates the issuer, audience, algorithm, key ID, signature, expiry, origin, and one-time nonce. It then resolves verified private identity/tenant mappings and rechecks the current Hub membership.

## Context resolution

The planned read contract is:

```http
GET /api/v1/help/resolve?product=pennfit&path=/members/invite&feature=member-invitations&locale=en-US&app_version=3.8.2
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
