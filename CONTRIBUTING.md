# Contributing

Thanks for improving `@mirrorstack-ai/app-module-client`. This package is a
small trust-boundary library, so API and transport changes should stay narrow,
explicit, and easy to audit.

## Prerequisites

- Node.js 20 or newer
- pnpm 10.29.3 (the version pinned by `packageManager`)

Enable Corepack if pnpm is not already available:

```bash
corepack enable
corepack prepare pnpm@10.29.3 --activate
pnpm install --frozen-lockfile
```

## Development

Create a branch named `feat/<issue>-<slug>` (or the corresponding `fix/`,
`docs/`, or `refactor/` form), then keep the change inside this repository.
Use conventional commit prefixes such as `feat:`, `fix:`, `docs:`, and
`refactor:`. Pull requests that resolve an issue should include
`Closes #<issue>`.

Keep these boundaries intact:

- no runtime dependencies or framework adapters;
- no module-specific endpoints, response types, or hooks;
- no implicit package scanning or dynamic plugin discovery;
- no internal dispatch routes;
- no browser exposure of delegation credentials, member assertions, or server
  secrets;
- no caller-controlled `X-MS-*` headers.

Add or update tests for behavior changes and update `README.md` for usage
changes. Feature and fix PRs must not bump `package.json` or edit
`CHANGELOG.md`; a dedicated release PR updates the version and changelog from
the merged changes.

## Verification

Run the same checks as CI:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

`pnpm pack:check` runs the build through the package's `prepack` hook and shows
the exact GitHub Packages tarball contents. Inspect the list whenever exports
or build configuration changes.

## Registry credentials

The committed `.npmrc` only selects GitHub Packages for the
`@mirrorstack-ai` scope. Supply authentication through `NODE_AUTH_TOKEN` or a
user-level npm configuration; never place a token in this repository.

Publishing and version tags are maintainer operations. CI validates a package
tarball but intentionally does not publish releases.
