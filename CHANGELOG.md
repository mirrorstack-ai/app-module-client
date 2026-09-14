# Changelog

All notable changes to this package are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.7.0

### Added

- `createAuthRoutes` takes an optional `landingPath(credential)`. The callback
  calls it after the exchange and redirects there, so an app whose home page
  immediately redirects a new member somewhere else — an onboarding form, a
  waiting-for-review page — stops making that member pay for two full server
  renders back to back. Through a Worker→Lambda origin the floor for one render
  is 0.5–0.9s (mirrorstack-ai/mirrorstack-core-v2#1393, measured from Taiwan
  2026-09-14), and at launch every member is a new member.

  The contract is deliberately narrow, because the return value becomes a
  redirect target: it must be a same-origin absolute path, it is bounded at 2s,
  and a throw, a timeout or a refused path all fall back to `paths.home` with a
  warning. A member who has just signed in successfully is never stranded
  because the app could not decide where to put them.

  🔴 A returned path that is not same-origin is refused, and each rejection is a
  measured escape rather than a style rule: `new URL()` resolves `//evil.com/x`
  and `/\evil.com` against the app's own origin as `https://evil.com` — the
  backslash because WHATWG treats it as a slash in a special scheme. Without
  that check, whatever feeds a resolver becomes an open-redirect surface on the
  one route that has just minted a session.

  Apps passing no resolver are unaffected: `paths.home` keeps its meaning and
  its type, and the callback redirects byte-for-byte as before.

## 0.6.0

### Fixed

- `createModuleProxyRoutes` no longer replays the CDN edge's own headers
  upstream. On a hosted tenant the request reaches the app carrying
  Cloudflare's `cf-connecting-ip`; forwarding it into the platform's
  Cloudflare zone made Cloudflare answer the call itself — `403 text/html`,
  "Error reference number: 1000" — so **every** browser-side module call on a
  hosted tenant failed, with a page no module client could parse.

  Measured against the live API, 12 trials per condition: a clean request
  answered `401` JSON 12/12; adding `cf-connecting-ip` produced the 1000 page
  12/12. Two findings worth keeping: `cf-connecting-ip` is the trigger
  (`x-forwarded-for`, `true-client-ip`, `cf-ray` and `cf-visitor` each changed
  nothing), and `cdn-loop: cloudflare` SUPPRESSES it — so stripping `cdn-loop`
  while still forwarding `cf-connecting-ip` would have made the failure
  certain rather than fixing it.

### Changed

- **Breaking for anyone relying on header pass-through.** Request headers are
  now an ALLOWLIST — `accept`, `accept-language`, `content-type`, the
  conditional-request headers, `range` and `user-agent` — rather than
  "everything except a named few". A denylist can only exclude headers someone
  thought of, which is exactly how this bug happened; the next CDN in front of
  a tenant (`fastly-client-ip`, `akamai-*`, `x-amzn-*`) would have reproduced
  it. Unknown no longer travels.

- New `extraRequestHeaders` option on `createModuleProxyRoutes` for an app or
  module that genuinely needs a custom header from the browser, so the
  allowlist does not silently drop a feature. A name that describes the network
  path (`cf-*`, `x-forwarded-*`, `cdn-loop`, `true-client-ip`, `forwarded`,
  `via`, and other CDN families) is refused at mount rather than in production.

## 0.5.1

### Changed

- Licensed under Apache-2.0 (no license was declared before).
- Also published to npmjs.com, so the package installs without a GitHub
  token. GitHub Packages still receives every release.

## 0.5.0

### Added

- `createModuleProxyRoutes` in `@mirrorstack-ai/app-module-client/next` — the
  catch-all App Router handlers a browser module client talks through when the
  member credential lives in an HttpOnly cookie.

  It exists here because every app that keeps its credential in a cookie needs
  byte-identical code, and two lines of it are invisible until they bite:
  `duplex: "half"`, required by undici whenever the body is a stream (so every
  upload throws before a byte leaves without it), and dropping
  `content-encoding` / `content-length` from the response (a copied length
  describes bytes that no longer exist, and the request hangs rather than
  failing). An app writing this by hand gets to discover both.

  It forwards; it does not decide. Authorization stays the platform's and the
  modules' answer on every request — this attaches a credential the member
  already holds and grants nothing that credential does not carry.

## [0.4.0] - 2026-09-06

### Added

- `./server`: `memberSessions()` — the app-scoped platform member-session
  control plane (one-time state, exchange, revoke) for custom web apps.
- `./next`: `createAuthRoutes()` — ready App Router start / callback / logout
  handlers over HttpOnly cookies, on top of `./server`; `next` is an optional
  peer dependency.

## [0.3.0] - 2026-09-05

## [0.3.0] - 2026-09-05

### Changed

- **Breaking.** `createAppClient` now composes an app dispatch root as
  `<baseUrl>/<scope>/<moduleRef>/<path>` — scope **before** module — matching
  the platform contract for custom web apps,
  `https://api.<org-domain>/v1/apps/app/<app-slug>/<scope>/<module-slug>/<path>`.
  It previously produced `<baseUrl>/<moduleRef>/<scope>/<path>`. A host that
  pinned the old shape (a test, a BFF route table) must update it. Module client
  packages that compose through `defineModuleClient({ moduleRef })` and
  scope-relative paths need no change.
- The `./web` runtime (`createModuleWebTransports` and the deprecated singular
  `createModuleWebTransport`) is **unchanged**: it receives a module root from
  its host and still appends `/<scope>/<path>`. A regression test pins that its
  output is byte-identical.

### Added

- `platformBaseUrl({ apiUrl, appSlug })` builds the base a custom web app passes
  to `createAppClient` from `MIRRORSTACK_API_URL` and `MIRRORSTACK_APP_SLUG`:
  `${apiUrl}/v1/apps/app/${appSlug}`. It requires an absolute HTTP(S) `apiUrl`
  without credentials, a query, or a fragment (trailing slashes are stripped, a
  path prefix is preserved) and a lowercase catalog-slug `appSlug`.

`MODULE_CLIENT_API_VERSION` is deliberately **not** bumped: the plugin contract
(`moduleRef` plus scope-relative paths) is unchanged, and raising it would reject
every existing plugin.

## [0.2.0] - 2026-09-02

### Fixed

- `createModuleWebTransports` now composes its **public** scope under `/public/`,
  matching where the Go Module SDK mounts `ms.Public` routes
  (`internal/core/module.go`, `sub.Route("/"+string(scope), fn)`). It previously
  resolved the public scope to the module root, so `public.get("/x")` addressed
  `<base>/x` and every browser call to a public route missed its handler. The
  platform scope was unaffected, and the non-web `createScopedTransports` already
  defaulted to the scope name, so the web runtime was the only surface that
  disagreed with the SDK.

### Changed

- **Breaking for callers of `transports.public`.** A module that worked around
  the defect by spelling the segment — `public.get("/public/x")` — now produces
  `<base>/public/public/x` and must drop the prefix. A module that requested
  `public.get("/x")` and 404ed is fixed with no change. Consumers pinning the
  absolute URL in a test will see that test fail rather than a silent
  double-prefix, which is the intended signal.
- The deprecated `createModuleWebTransport` (singular) is **unchanged**: it is
  documented as serving public-root and platform-scoped routes, its callers pass
  whole paths, and it keeps addressing the module root. A regression test pins
  `/public/x`, `/platform/x` and a root-level route through it.

`MODULE_CLIENT_API_VERSION` is deliberately **not** bumped. It gates plugin
compatibility through a strict equality check in `createAppClient`, so raising it
would reject every plugin built against the current version, and this change does
not alter the plugin contract.

Closes #10.

## [0.1.1] - 2026-08-30

### Added

- Complete public and platform transports for mounted module web surfaces,
  including the full scoped request contract and transport-owned JSON bodies.
- Streaming byte limits for parsed success bodies, error bodies, and
  authentication-refresh inspection, with raw responses left caller-owned.
- Framework-neutral localized-text selection, isolated subpath state, and an
  observable contributed-component mounting lifecycle.
- Typed manifest-component mount contexts with authoritative installed-module
  IDs and an optional `./web/react` adapter for React mounting, shared clocks,
  and platform unsaved-state synchronization.

### Changed

- Catalog slug validation now matches the Go Module SDK's canonical 1–16
  character contract.
- Browser mount `appId` values are informational and are never emitted as
  trusted `X-MS-App-ID` request headers.
- The v0.1.0 text cache, singular web transport, and mount-context alias remain
  source- and runtime-compatible.

### Fixed

- The packed-package CI smoke test imports the actual plural
  `createModuleWebTransports` runtime export.

## [0.1.0] - 2026-08-29

### Added

- Framework-neutral, typed module plugin definition and explicit app-client
  composition.
- Dispatch URL construction for `public` and `platform` module scopes.
- Injectable fetch, headers, credentials, and platform authentication.
- Context-rich `ModuleClientError` responses plus fail-fast configuration and
  path validation.
- A mount-scoped text cache, direct web transport, and platform mount
  contracts under the framework-neutral `./web` entry point.
- ESM-only TypeScript declarations and zero required runtime dependencies.

[0.4.0]: https://github.com/mirrorstack-ai/app-module-client/releases/tag/v0.4.0
