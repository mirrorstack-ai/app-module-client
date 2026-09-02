# @mirrorstack-ai/app-module-client

Framework-neutral, typed composition for calling MirrorStack application
modules. The package builds dispatch URLs, applies injected transport policy,
and composes explicitly registered module plugins into one app client. It is
ESM-only and has zero runtime dependencies. Optional UI adapters live behind
explicit entry points with optional peer dependencies.

V1 deliberately has no server-framework adapter, module-specific endpoint or
domain/query hooks, or implicit plugin discovery. Optional generic React
lifecycle helpers remain isolated behind the `./web/react` entry point.

> Version `0.2.0` composes the web **public** scope under `/public/`, matching
> where the Go Module SDK mounts `ms.Public` routes. Callers that worked around
> the previous module-root behaviour by spelling the segment must drop it. The
> deprecated `createModuleWebTransport()` still addresses the module root, and
> the `0.1.0` web cache and compatibility transport exports remain.

## Install

The package is published to GitHub Packages. Configure the scope in the
consuming project and provide authentication through the environment (do not
commit a token):

```ini
# .npmrc
@mirrorstack-ai:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```bash
pnpm add @mirrorstack-ai/app-module-client
```

Node.js 20 or newer is required.

## Compose an app client

Each module publishes a plugin from its own client package. The host imports
the plugins it uses and registers them under explicit, typed local names:

```ts
import { createAppClient } from "@mirrorstack-ai/app-module-client";
import { userCore } from "@mirrorstack-ai/user-core-client/plugin";

const client = createAppClient({
  // A same-origin BFF base is recommended for browser applications.
  baseUrl: "/api/mirrorstack/modules",
  modules: {
    user: userCore(),
  },
});

const me = await client.modules.user.getMe();
```

The `user` object key is only the host's typed access name. The plugin's
`moduleRef` controls the dispatch URL. Registration is static and explicit:
the package does not scan `node_modules`, load plugins dynamically, or infer
installed modules.

Catalog slug references use the same canonical contract as the Go Module SDK:
one to 16 ASCII characters matching `[a-z][a-z0-9-]{0,15}`. Installed-module
UUID references remain accepted as well.

## Author a module client

Endpoint methods, request/response types, and any framework-specific hooks stay
in the module's own client package. That package defines its typed surface with
`defineModuleClient`:

```ts
import { defineModuleClient } from "@mirrorstack-ai/app-module-client";

export interface Asset {
  id: string;
  title: string;
}

export interface AssetLibraryClientOptions {
  // An installed module can be addressed by its catalog slug or UUID.
  moduleRef?: string;
}

export const assetLibrary = ({
  moduleRef = "asset-library",
}: AssetLibraryClientOptions = {}) =>
  defineModuleClient({
    moduleRef,
    create({ public: publicScope, platform }) {
      return {
        getAsset: (id: string) => publicScope.get<Asset>(`/assets/${id}`),
        archiveAsset: (id: string) =>
          platform.post(`/assets/${id}/archive`, { responseType: "void" }),
      };
    },
  });
```

Both scopes expose typed request helpers. For example,
`.get<T>(path, { query?, responseType? })` performs a GET,
`.post<T>(path, { json: payload })` sends JSON, and `.url(path, query)` builds a
navigation URL without making a request. A module package may wrap those
primitives however its own API requires.

JSON is the default response type and requires a JSON body. Endpoints returning
`204`, `205`, or another empty success must explicitly use
`responseType: "void"`; this keeps the declared return type honest.
When the `json` option is present, the transport owns both serialization and
`Content-Type: application/json`; merged header sources cannot override it.
Raw `body` requests retain caller-owned media types.

Only `public` and `platform` are client scopes. MirrorStack internal routes are
intentionally not represented.

## Base URL model

`baseUrl` identifies the app dispatch root. The core appends the plugin's
module reference, scope, and endpoint path:

```text
<baseUrl>/<moduleRef>/<scope>/<path>
```

For a browser, prefer a same-origin BFF such as:

```text
/api/mirrorstack/modules/user-core/public/me
```

The BFF owns the upstream app reference and any server-side credentials. For a
direct dispatch connection, the current canonical base includes the app
reference:

```text
https://api.<org-domain>/v1/dispatch/apps/<appRef>
https://api.<org-domain>/v1/dispatch/apps/<appRef>/user-core/public/me
```

`<org-domain>` is the organization's configured domain; it is not required to
be `mirrorstack.ai`.

Keep any deployment prefix in `baseUrl`; endpoint paths are appended rather
than resolved from the origin root.

## Transport and platform authentication

`createAppClient` accepts injected `fetch`, `headers`, and `credentials`
options so the host controls transport without coupling module packages to a
runtime or framework. `credentials` defaults to `"include"`; set it explicitly
only when the host needs a different standard Fetch credentials policy.

Parsed success bodies, parsed error bodies, and authentication-refresh error
inspection are bounded to one mebibyte by default. Set `maxResponseBytes` to a
positive byte count when a host has a narrower or explicitly larger contract.
The limit is enforced while streaming even when `Content-Length` is missing or
incorrect. A raw scoped `.fetch()` or `responseType: "response"` transfers body
ownership and size enforcement to its caller.

Platform requests have an additional, deliberately narrow authentication
path. A host may provide `platformAuth.getAccessToken` and optionally
`platformAuth.refreshAccessToken`; these callbacks are considered only for the
`platform` scope. Public requests never receive that token. Without
`platformAuth`, a platform request can instead go through a same-origin BFF
that owns authentication.

Those callbacks return only an end-user access token that is safe for that
host to send as an `Authorization: Bearer` value. They must never return or
expose `X-MS-Platform-Token`, `X-MS-Internal-Secret`, a delegation credential,
member assertion, signing key, or any other server credential.

When `platformAuth` is present, `getAccessToken` must return a non-empty token;
otherwise the platform request fails before any network call. A configured
refresh callback must likewise return a non-empty replacement token before the
client will retry. Omit `platformAuth` when a same-origin BFF authenticates the
request itself.

When `refreshAccessToken` is configured, a platform request may refresh and
retry once only after a `401` response whose dispatch error code is
`token_expired` or `token_missing`. Automatic replay is limited to safe
`GET`, `HEAD`, and `OPTIONS` requests. The client never automatically replays
`POST`, `PUT`, `PATCH`, or `DELETE`, an arbitrary module `401`, a public
request, or a request with a non-replayable streaming body.

Scoped requests always use Fetch's `redirect: "error"` policy and reject a
caller-supplied redirect override. A module-controlled redirect therefore
cannot carry cookies or a platform Bearer to a URL outside the registered
module and scope.

Callers cannot set `Authorization` manually on platform requests, and all
caller-provided `X-MS-*` headers are rejected. In browser code, never make a
delegation credential, member assertion, signing key, or server secret available
to this package—or to any other client-side code. Keep those values behind the
BFF boundary.

## Error handling

The parsed request helpers (`get`, `post`, `put`, `patch`, `delete`, and
`request`) reject non-successful responses with `ModuleClientError`. Catch the
class to inspect transport-neutral context without coupling a module package to
a framework:

```ts
import { ModuleClientError } from "@mirrorstack-ai/app-module-client";

try {
  await client.modules.user.getMe();
} catch (error) {
  if (!(error instanceof ModuleClientError)) throw error;

  console.error({
    status: error.status,
    code: error.code,
    details: error.details,
    body: error.body,
    requestId: error.requestId,
    moduleRef: error.moduleRef,
    scope: error.scope,
    path: error.path,
  });
}
```

The error preserves the HTTP status and parsed error data when available, plus
the module/scope/path context that produced the request. Authentication refresh
is handled before the final error is exposed and is subject to the one-retry,
replay-safe rule above. The lower-level scoped `.fetch()` deliberately returns
the raw `Response` and leaves HTTP-status handling to its caller. Network,
abort, and local validation failures remain their native errors; they are not
wrapped in `ModuleClientError`.

## Responsibilities

| Layer | Owns | Does not own |
| --- | --- | --- |
| This package | Typed plugin composition, dispatch URL construction, `public`/`platform` request primitives, injected fetch/headers/credentials, shared errors, generic web/React lifecycle helpers | Module endpoint catalogs, domain response models and query hooks, auth issuance, internal routes |
| A module client package | Its endpoint methods and types; optional framework hooks in its own explicit entry points | Other modules, app authentication policy, plugin discovery |
| A browser host | Explicit plugin selection, same-origin base URL, browser-safe transport and access-token integration | Delegation credentials, member assertions, signing keys, server secrets, module contracts |
| A server host or BFF | Upstream app base/reference, cookies or access tokens, trusted assertions, runtime-specific forwarding | Exposing trusted credentials to browser code, re-declaring module contracts |

## Discovery status

There is currently no CLI or Module SDK integration that generates or
auto-discovers client plugins. Installing a module does not add client code to
an application automatically. Hosts must install each module's client package,
import its plugin, and register it in the `modules` object themselves.

`@mirrorstack-ai/user-core-client/plugin` is the first hand-authored
first-party integration. Cross-repository canaries validate its typed
`/public/me` call against the canonical DispatchApp URL shape.

## Mounted module web surfaces

Use `@mirrorstack-ai/app-module-client/web` inside a module-owned web bundle. It
provides the platform mount contract, scoped module transports, localized-text
selection, and mount-local subpath state without introducing React as a
dependency.

~~~ts
import { createModuleWebTransports } from "@mirrorstack-ai/app-module-client/web";

const api = createModuleWebTransports({
  moduleRef: "user-core",
  apiBase: context.apiBase,
  fetch: context.fetch,
});

const users = await api.platform.get("/users");
~~~

The mount host owns authentication and supplies fetch. Module web code owns only
its domain routes and UI. Public and platform routes are separate transports;
callers never encode the `/platform` scope into a route string or supply a
trusted `X-MS-*` application identity header.

`context.appId` is informational mount-local data for state and links. Browser
code must never treat it as trusted request identity or turn it into an
`X-MS-App-ID` header; the host transport owns authoritative application scope.

Send JSON with the same transport-owned serialization used by composed module
clients:

~~~ts
await api.platform.patch("/settings", {
  json: { sessionLifetimeDays: 30 },
  responseType: "void",
});
~~~

Create one subpath store per mount so navigation snapshots cannot leak between
module instances:

~~~ts
import { createModuleSubpathStore } from "@mirrorstack-ai/app-module-client/web";

const subpath = createModuleSubpathStore(context.subpath);
subpath.publish([{ segment: "users", label: "Users" }]);
// Call subpath.dispose() when this mount is removed.
~~~

The v0.1.0 mount-local text cache remains available for callers that need
request coalescing and bounded retention without sharing parsed objects between
consumers:

~~~ts
import { createModuleTextCache } from "@mirrorstack-ai/app-module-client/web";

const cache = createModuleTextCache();
const text = await cache.cachedText("users", (signal) =>
  api.platform.get("/users", { signal, responseType: "text" }),
);
const users = JSON.parse(text);

// On owner teardown:
cache.clear();
~~~

`createModuleWebTransport()` also remains exported for v0.1.0 source
compatibility. New code should use the plural `createModuleWebTransports()`
API so public and platform routes cannot be confused. Its legacy `appId`
option is informational only and is never emitted as a trusted browser
`X-MS-App-ID` header.

When mounting a component contributed by another installed module, hosts should
resolve and pass its authoritative `moduleId`. The optional `moduleSlug` is only
a routing/display hint when an ID is present; slug-only mounts remain accepted
for compatibility with older hosts.

Use the framework-neutral lifecycle wrapper so each contribution mounts into a
child created by the target's own document and late asynchronous mounts cannot
survive their owner:

~~~ts
import { mountModuleComponent } from "@mirrorstack-ai/app-module-client/web";

const contribution = mountModuleComponent(target, (componentTarget) =>
  context.modules!.mount({
    moduleId,
    component: "user-badge",
    target: componentTarget,
    props: { userId },
  }),
);

const unsubscribe = contribution.subscribe(renderAvailability);
renderAvailability(); // Inspect contribution.getSnapshot() and getError().

// On owner teardown:
unsubscribe();
contribution.dispose();
~~~

The observable snapshot (`mounting`, `ready`, `unavailable`, or `disposed`) can
also feed React's `useSyncExternalStore` without moving this lifecycle into the
React entry point.

Component exports can type their validated props and emitted payloads with
`ModuleComponentMountContext<TProps, TEventPayload>` instead of redeclaring the
host bridge in every bundle.

React modules may opt into the separate adapter. Consumers of this entry point
must install `react` and `react-dom`; neither is loaded by the root or `./web`
entry point.

~~~tsx
import {
  mountReactSurface,
  useNow,
  usePlatformUnsavedState,
} from "@mirrorstack-ai/app-module-client/web/react";

function App() {
  const now = useNow(); // Refreshes every 30 seconds; no document/window required.
  usePlatformUnsavedState(context.unsaved, dirty ? unsavedState : null);
  return <time>{new Date(now).toISOString()}</time>;
}

const dispose = mountReactSurface(target, {
  moduleSlug: "user-core",
  styles: compiledStyles,
  element: <App />,
  dispose: () => runtime.dispose(),
});
~~~

The adapter registers each exact compiled stylesheet once per document. Mounts
that share it retain the same style element, which is removed after the final
mount is cleaned up.
