# Changelog

All notable changes to this package are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
