# `@caremetric/help-sdk`

The first-party CareMetric Help SDK opens product-aware guidance in the central
Support Hub. It has no runtime dependencies, stores no support data, and sends
only the small allowlist represented by `HelpContext`.

The SDK deliberately has no fields for people, tenants, patients, tickets,
access tokens, or arbitrary metadata. Support cases and identity remain under
the Support Hub's own authentication and database controls.

## Build and install

Create an installable tarball from the Support Hub repository:

```bash
npm ci
npm run pack:sdk
```

This produces `caremetric-help-sdk-0.2.0.tgz`. Place that versioned artifact in
the consuming application's private source tree and install it:

```bash
npm install ./vendor/caremetric-help-sdk-0.2.0.tgz
```

Keeping the tarball versioned with each private application makes builds
reproducible without adding a help-desk vendor or a runtime service dependency.

## Open contextual help

Production apps should omit `baseUrl`. The SDK defaults to the live central
Support Hub, `https://support-hub-web-production.up.railway.app`, preventing a
development app's localhost origin from becoming the help link.

```ts
import { openHelp } from "@caremetric/help-sdk";

button.addEventListener("click", () => {
  const supportRoutes = ["/members/:memberId"] as const;
  openHelp({
    routeAllowlist: supportRoutes,
    featureAllowlist: ["member-profile"],
    context: {
      product: "breathe",
      route: "/members/:memberId",
      feature: "member-profile",
      appVersion: APP_VERSION,
      locale: "en-US",
      environment: "production"
    }
  });
});
```

For a normal anchor, React router, or server-rendered view, build the link
without accessing `window`:

```ts
import { buildHelpUrl } from "@caremetric/help-sdk";

const helpHref = buildHelpUrl({
  routeAllowlist: ["/assessments/:assessmentId"],
  context: { product: "pennsync", route: "/assessments/:assessmentId" }
});
```

Use `baseUrl` only for an explicit staging/development Hub environment:

```ts
buildHelpUrl({
  baseUrl: "https://support-hub-staging.example.internal",
  context: { product: "breathe", environment: "staging" }
});
```

## Privacy rules

- Pass a stable route template, never the full browser URL or a record ID.
- Register routes and feature keys in compile-time constant allowlists. The SDK
  omits them unless they exactly match the registry; never pass
  `window.location.pathname` directly.
- The SDK removes query strings and fragments defensively, rejects loopback
  destinations, and accepts only the six registered CareMetric products.
- Never add user, tenant, patient, clinical, free-text, token, or diagnostic
  values to a help URL.
- Use `buildHelpUrl` during server rendering; call `openHelp` only from a
  browser interaction.

Central support: `support@caremetric.ai` · `(877) 521-2890`.
