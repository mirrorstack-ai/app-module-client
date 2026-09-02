# Changelog

All notable changes to this package are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
