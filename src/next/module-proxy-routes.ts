import { platformBaseUrl } from "../base-url.js";

/**
 * The ONE server hop a browser module client talks through.
 *
 * 🔴 WHY THIS EXISTS AT ALL. A custom app keeps its member credential in an
 * HttpOnly cookie, which is the point of an HttpOnly cookie — script cannot
 * read it, so the browser cannot call the platform itself. That is the ONLY
 * thing the browser is missing. This supplies exactly that and forwards
 * everything else untouched.
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
 * Headers that must NOT be replayed upstream.
 *
 * `cookie` above all: the app's session cookie is its own, and forwarding it
 * hands a second credential to a service that never asked for one. The length
 * and hop-by-hop headers are re-derived by fetch, and a stale `content-length`
 * copied onto a re-encoded body is a hung request. `authorization` is dropped
 * because this hop sets it — a caller-supplied one must never survive.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  "cookie",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "authorization",
  "accept-encoding",
]);

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

  async function forward(request: Request, context: RouteContext): Promise<Response> {
    const credential = await options.readMemberCredential();
    if (!credential) return new Response(null, { status: 401 });

    const { path } = await context.params;
    const target = new URL(`${base}/${path.join("/")}`);
    target.search = new URL(request.url).search;

    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
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
