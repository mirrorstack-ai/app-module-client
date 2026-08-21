# Changelog

All notable changes to this package are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Framework-neutral, typed module plugin definition and explicit app-client
  composition.
- Dispatch URL construction for `public` and `platform` module scopes.
- Injectable fetch, headers, credentials, and platform authentication.
- Context-rich `ModuleClientError` responses plus fail-fast configuration and
  path validation.
- ESM-only TypeScript declarations and zero runtime dependencies.
