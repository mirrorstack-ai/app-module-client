# Repository guidance

## Purpose and invariants

`@mirrorstack-ai/app-module-client` is the framework-neutral, ESM-only client
composition layer for MirrorStack application modules.

- Keep runtime dependencies at zero. Do not add React, server-framework
  adapters, query libraries, or module-specific endpoint code.
- Keep module registration explicit and static. Never scan `node_modules` or
  introduce runtime discovery/dynamic imports.
- The only module scopes are `public` and `platform`; internal routes are not a
  client surface.
- Treat credentials as a trust boundary. Public requests never receive a
  platform token. Browser code must never receive delegation credentials,
  member assertions, or server secrets. Reject caller-controlled `X-MS-*`
  headers.
- A dispatch base already identifies the app. Requests append
  `/<moduleRef>/<scope>/<path>`; preserve base-path prefixes.
- Module endpoint methods, wire types, and framework hooks belong in each
  module's own client package.

## Source map

- `src/index.ts` is the package's public export boundary.
- `src/plugin.ts` defines the plugin contract and its two allowed scopes;
  `src/client.ts` validates and composes the explicit module map.
- `src/transport.ts` owns confined URL/request behavior and transport/auth
  injection; `src/error.ts` owns the public HTTP error.
- `src/**/*.{test,spec}.ts` and `tests/**/*.{test,spec}.ts` cover behavior and
  contract boundaries; neither is emitted.
- `README.md` is the canonical package documentation. Keep design guidance
  here rather than adding temporary docs or runbooks.

## Change protocol

Use Node 20 or newer and pnpm 10.29.3. Preserve NodeNext `.js` specifiers in
relative TypeScript imports. Any public API change needs tests and a README
update when usage changes. Feature and fix PRs must not change the package
version or `CHANGELOG.md`; a dedicated release PR owns both. Never commit
registry tokens or other credentials.

Before handing off a change, run:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```
