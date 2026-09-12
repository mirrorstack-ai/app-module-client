import { platformBaseUrl } from "../base-url.js";

/**
 * The ONE server hop a browser module client talks through.
 *
 * 🔴 WHY THIS EXISTS AT ALL. A custom app keeps its member credential in an
 * HttpOnly cookie, which is the point of an HttpOnly cookie — script cannot
 * read it, so the browser cannot call the platform itself. That is the ONLY
 * thing the browser is missing. This supplies exactly that and forwards the
 * request otherwise unchanged — through a header ALLOWLIST, not untouched:
 * a hosted tenant's request arrives carrying its CDN edge's own headers, and
 * replaying those into the platform's CDN zone is what made every browser-side
 * module call on a hosted tenant fail. See {@link FORWARDED_REQUEST_HEADERS}.
 *
 * 🔴 WHY IT IS HERE RATHER THAN IN EACH APP. Every app that keeps its
 * credential in a cookie needs byte-identical code, and two lines of it are
 * invisible until they bite:
 *
 *   - `duplex: "half"` is REQUIRED by undici whenever the body is a stream,
 *     which it is for any upload. Without it the fetch throws before a byte
 *     leaves, and the error names neither the upload nor the cause.
 *   - `content-encoding` / `content-length` MUST be dropped from the response.
 *     The body has already been decoded by the time it is re-sent, so a copied
 *     `content-length` describes bytes that no longer exist and the request
 *     hangs rather than failing.
 *
 * An app that writes this by hand gets to discover both. kaohsiung-association
 * carried a hand-written copy of this file, 98 lines, containing no knowledge
 * of any module — which is what made it boilerplate rather than app code.
 *
 * The alternative shape — a hand-written endpoint per operation — re-declares
 * each module's contract inside the app: one more place to keep in step every
 * time a module changes, and the generated client's types and errors are
 * discarded on the way through. With this mounted the browser uses the real
 * module client and this file never learns what any call means.
 *
 * 🔴 IT FORWARDS, IT DOES NOT DECIDE. Authorization remains the platform's and
 * the modules' answer on every request. This attaches a credential the member
 * already holds and grants nothing that credential does not carry.
 */

/** Inputs for {@link createModuleProxyRoutes}. */
export interface ModuleProxyRoutesOptions {
  /** Absolute HTTP(S) platform API URL, typically `MIRRORSTACK_API_URL`. */
  readonly apiUrl: string;
  /** The custom application's slug, typically `MIRRORSTACK_APP_SLUG`. */
  readonly appSlug: string;
  /**
   * Reads the member credential for the current request. Pass the
   * `readMemberCredential` from {@link createAuthRoutes}, so the proxy and
   * sign-in cannot disagree about where the session lives.
   */
  readonly readMemberCredential: () => Promise<string | null>;
  /**
   * Extra request headers to replay upstream, beyond the built-in allowlist.
   *
   * The allowlist is deliberately small, so an app or module that genuinely
   * needs a custom header from the browser names it here rather than having it
   * dropped silently. Matched case-insensitively.
   *
   * A name that describes the NETWORK PATH rather than the request is refused
   * at construction — `cf-*`, `x-forwarded-*`, `true-client-ip`, `forwarded`,
   * `cdn-loop` and friends are exactly what broke hosted tenants, and an
   * escape hatch that let one back in would reopen the hole it exists beside.
   */
  readonly extraRequestHeaders?: readonly string[];
  /** Fetch implementation for the upstream call. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** A Next.js App Router route module: one handler per forwarded method. */
export interface ModuleProxyRoutes {
  GET(request: Request, context: RouteContext): Promise<Response>;
  POST(request: Request, context: RouteContext): Promise<Response>;
  PUT(request: Request, context: RouteContext): Promise<Response>;
  PATCH(request: Request, context: RouteContext): Promise<Response>;
  DELETE(request: Request, context: RouteContext): Promise<Response>;
}

/** The second argument Next hands a catch-all route handler. */
export interface RouteContext {
  readonly params: Promise<{ path: string[] }>;
}

/**
 * Request headers this hop replays upstream. Everything else is dropped.
 *
 * 🔴 THIS IS AN ALLOWLIST, AND IT USED TO BE A DENYLIST. A denylist forwarded
 * every header the request arrived with, which on a hosted tenant means every
 * header the CDN edge added on the way in. Replaying Cloudflare's
 * `cf-connecting-ip` into the api.mirrorstack.ai zone made Cloudflare answer
 * the request itself — `403 text/html`, "Error reference number: 1000" — so
 * EVERY browser-side module call on a hosted tenant failed, and failed with a
 * page no module could interpret.
 *
 * Measured against the live API on 2026-09-12, 12 trials per condition:
 *
 *   no edge headers                    → 401 JSON   (0/12 gave 1000)
 *   + cf-connecting-ip                 → 1000       (12/12)
 *   + cf-connecting-ip and cdn-loop    → 401 JSON   (0/12)
 *
 * Two things follow, and the second is a trap. `cf-connecting-ip` is the
 * trigger — `x-forwarded-for`, `true-client-ip`, `cf-ray` and `cf-visitor`
 * each changed nothing. And `cdn-loop: cloudflare` SUPPRESSES it: Cloudflare
 * reads the pair as a legitimate CDN-to-CDN hop. So stripping `cdn-loop` while
 * still forwarding `cf-connecting-ip` would turn an intermittent failure into
 * a certain one. An allowlist removes both together and cannot get that wrong.
 *
 * The deeper reason for the inversion: this bug was an intermediary adding a
 * header nobody had thought of. A denylist can only ever exclude headers
 * someone thought of, so the next CDN in front of a tenant — `fastly-client-ip`,
 * `akamai-*`, `x-amzn-*` — would reproduce it exactly. Unknown does not travel.
 *
 * `cookie` and `authorization` are absent for their own reasons and would be
 * even if no CDN existed: the app's session cookie is its own, and forwarding
 * it hands a second credential to a service that never asked for one; this hop
 * sets `authorization` itself, so a caller-supplied one must never survive.
 * `content-length` and the hop-by-hop headers are re-derived by fetch.
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  // Conditional requests: a module serving ETags is useless if the validator
  // cannot reach it, and the response side already passes ETag back.
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "range",
  // Carried so a module's own logs can tell browsers apart. It names the
  // client, not the network path, so it is not part of the failure above.
  "user-agent",
]);

/**
 * Header names and prefixes that describe the network path a request took,
 * not the request itself. Added by CDNs, load balancers and reverse proxies;
 * never meaningful to a module, and actively harmful to replay into another
 * CDN zone (see {@link FORWARDED_REQUEST_HEADERS}).
 *
 * Used ONLY to refuse a bad `extraRequestHeaders` entry. The allowlist alone
 * already keeps every one of these out; this exists so an app cannot opt back
 * into the exact failure the allowlist was introduced to end, and so it learns
 * that at construction rather than from a Cloudflare error page in production.
 */
const PATH_DESCRIBING_HEADER_PREFIXES = ["cf-", "x-forwarded-", "akamai-", "fastly-", "x-amzn-"];
const PATH_DESCRIBING_HEADERS = new Set([
  "cdn-loop",
  "forwarded",
  "true-client-ip",
  "x-real-ip",
  "via",
]);

function describesNetworkPath(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    PATH_DESCRIBING_HEADERS.has(lower) ||
    PATH_DESCRIBING_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

/**
 * The effective request-header allowlist: the built-in set plus any opted-in
 * extras, lowercased. Throws on an extra that describes the network path.
 */
function resolveForwardedHeaders(extra: readonly string[] | undefined): ReadonlySet<string> {
  if (extra === undefined || extra.length === 0) return FORWARDED_REQUEST_HEADERS;
  const resolved = new Set(FORWARDED_REQUEST_HEADERS);
  for (const name of extra) {
    const lower = name.toLowerCase();
    if (describesNetworkPath(lower)) {
      throw new TypeError(
        `extraRequestHeaders must not include ${lower}: it describes the network path, ` +
          "and replaying such a header into the platform's CDN zone is what made every " +
          "browser-side module call on a hosted tenant fail",
      );
    }
    resolved.add(lower);
  }
  return resolved;
}

/**
 * Build the catch-all route handlers for a module proxy.
 *
 * Mount at `app/api/mirrorstack/modules/[...path]/route.ts`:
 *
 * ```ts
 * export const runtime = "nodejs";
 * export const { GET, POST, PUT, PATCH, DELETE } = createModuleProxyRoutes({
 *   apiUrl: process.env.NEXT_PUBLIC_MIRRORSTACK_API!,
 *   appSlug: process.env.NEXT_PUBLIC_APP_ID!,
 *   readMemberCredential: auth.readMemberCredential,
 * });
 * ```
 *
 * The browser client's `baseUrl` is then that same mount path.
 */
export function createModuleProxyRoutes(options: ModuleProxyRoutesOptions): ModuleProxyRoutes {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = platformBaseUrl({ apiUrl: options.apiUrl, appSlug: options.appSlug });
  // Resolved once, at mount: a bad extra header fails when the route module is
  // built, not on the first request that happens to carry it.
  const forwarded = resolveForwardedHeaders(options.extraRequestHeaders);

  async function forward(request: Request, context: RouteContext): Promise<Response> {
    const credential = await options.readMemberCredential();
    if (!credential) return new Response(null, { status: 401 });

    const { path } = await context.params;
    const target = new URL(`${base}/${path.join("/")}`);
    target.search = new URL(request.url).search;

    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (forwarded.has(name.toLowerCase())) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${credential}`);

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const response = await doFetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      duplex: "half",
      redirect: "manual",
    } as RequestInit & { duplex: "half" });

    // The upstream status and body are returned as they are, so a module's own
    // "too large" or "wrong type" reaches the caller instead of a generic
    // failure nobody can act on.
    const out = new Headers(response.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    out.delete("transfer-encoding");
    return new Response(response.body, { status: response.status, headers: out });
  }

  return {
    GET: forward,
    POST: forward,
    PUT: forward,
    PATCH: forward,
    DELETE: forward,
  };
}
