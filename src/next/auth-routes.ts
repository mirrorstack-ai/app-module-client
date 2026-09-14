import { cookies } from "next/headers.js";
import {
  memberSessions,
  type MemberSessionsApi,
} from "../server/member-sessions.js";

/**
 * Ready-made sign-in routes for a custom web app on the Next.js App Router.
 *
 * A custom app runs on its own origin, and the auth provider's own session
 * cookie lives on the platform host, so the app has to (1) issue a one-time
 * state and send the browser to the provider, (2) take the one-time code the
 * provider appends to the redirect and exchange it for a platform member
 * session, (3) keep that credential in an HttpOnly cookie on its origin, and
 * (4) revoke it on sign-out. Every custom app needs exactly these four steps,
 * so they live here once, and an app's route file is one export line:
 *
 * ```ts
 * // src/lib/auth.ts
 * export const auth = createAuthRoutes({ apiUrl, appSlug, provider: client.modules.userCore });
 * // src/app/api/auth/start/route.ts
 * export const { GET } = auth.start;
 * ```
 */

/** The part of an auth-provider plugin this adapter needs: how to start a sign-in. */
export interface AuthProviderStart {
  startUrl(provider: string, options: { redirect: string; handoffState: string }): string;
}

/** Inputs for {@link createAuthRoutes}. */
export interface AuthRoutesOptions {
  /** Absolute HTTP(S) platform API URL, typically `MIRRORSTACK_API_URL`. */
  readonly apiUrl: string;
  /** The custom application's slug, typically `MIRRORSTACK_APP_SLUG`. */
  readonly appSlug: string;
  /** The auth-provider plugin that builds the sign-in URL, e.g. `client.modules.userCore`. */
  readonly provider: AuthProviderStart;
  /**
   * The query parameter the provider appends to the redirect with the one-time
   * code. User Core sends `ms_handoff`; take the name from the provider's
   * client when it exports one.
   *
   * @defaultValue `"ms_handoff"`
   */
  readonly handoffParam?: string;
  /** App paths. Defaults: callback `/api/auth/callback`, login `/login`, home `/`. */
  readonly paths?: {
    readonly callback?: string;
    readonly login?: string;
    readonly home?: string;
  };
  /** Cookie names and lifetimes. */
  readonly cookies?: {
    /** @defaultValue `"ms_member_session"` */
    readonly session?: string;
    /** @defaultValue `"ms_handoff_state"` */
    readonly state?: string;
    /** @defaultValue 8 hours */
    readonly sessionMaxAgeSeconds?: number;
    /** @defaultValue 10 minutes */
    readonly stateMaxAgeSeconds?: number;
  };
  /**
   * Where a member belongs immediately after signing in, decided from the
   * credential just minted. Optional; without it the callback redirects to
   * `paths.home` exactly as before.
   *
   * 🔴 THIS EXISTS TO REMOVE A WHOLE SSR ROUND TRIP, not to be clever. An app
   * whose home page immediately redirects a new member somewhere else — an
   * onboarding form, a waiting-for-review page — makes that member pay for two
   * full server renders back to back, and through a Worker→Lambda origin the
   * floor for one is 0.5–0.9s (mirrorstack-core-v2#1393, measured from TW
   * 2026-09-14). At launch every member is a new member, so every member pays
   * it. Deciding the destination HERE, where the credential already exists,
   * replaces the second render with the module read the app was going to make
   * a moment later anyway.
   *
   * The contract is deliberately narrow, because the return value becomes a
   * redirect target:
   *   - it must be a same-origin ABSOLUTE PATH (`/onboarding?status=x`);
   *     anything else is refused and `paths.home` is used instead
   *   - it is bounded ({@link LANDING_TIMEOUT_MS}); a slow resolver costs the
   *     member nothing
   *   - it never fails the sign-in: a throw, a timeout or a refused path all
   *     fall back to `paths.home`, which is exactly today's behaviour
   *
   * A member who has just signed in successfully must never be stranded
   * because this app could not decide where to put them. The failure is the
   * app's, not theirs.
   */
  readonly landingPath?: (credential: string) => string | Promise<string>;
  /** Fetch implementation for the platform calls. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** What {@link createAuthRoutes} returns. */
export interface AuthRoutes {
  /** `GET /api/auth/start?provider=<slug>` — issue state, redirect to the provider. */
  readonly start: { GET(request: Request): Promise<Response> };
  /** `GET /api/auth/callback?<handoffParam>=<code>` — exchange the code, set the session cookie. */
  readonly callback: { GET(request: Request): Promise<Response> };
  /** `POST /api/auth/logout` — revoke on the platform, then clear the cookie. */
  readonly logout: { POST(request: Request): Promise<Response> };
  /** The member credential for the current request, or null when signed out. Server-side only. */
  readMemberCredential(): Promise<string | null>;
  /** The member-sessions API these routes use, for callers that need it directly. */
  readonly sessions: MemberSessionsApi;
}

const DEFAULT_SESSION_COOKIE = "ms_member_session";
const DEFAULT_STATE_COOKIE = "ms_handoff_state";
const DEFAULT_SESSION_MAX_AGE = 8 * 60 * 60;
const DEFAULT_STATE_MAX_AGE = 10 * 60;
const DEFAULT_HANDOFF_PARAM = "ms_handoff";
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PROVIDER_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;

function assertPath(value: string, label: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    throw new TypeError(`${label} must be an absolute path on this app`);
  }
  return value;
}

/** How long {@link AuthRoutesOptions.landingPath} may take before the callback gives up on it. */
const LANDING_TIMEOUT_MS = 2_000;

/**
 * Whether a resolver's answer is safe to redirect to.
 *
 * 🔴 EVERY REJECTION HERE IS A MEASURED CROSS-ORIGIN ESCAPE, not a style rule.
 * The callback resolves the value against the request URL, and `new URL()`
 * (Node 24, WHATWG) turns each of these into another origin entirely:
 *
 *     new URL("//evil.com/x",  "https://app/...")  ->  https://evil.com/x
 *     new URL("/\\evil.com",   "https://app/...")  ->  https://evil.com/
 *     new URL("https://evil.com", "https://app/...") -> https://evil.com/
 *
 * The backslash is the one that looks harmless: WHATWG treats `\` as `/` in a
 * special scheme, so `/\evil.com` IS `//evil.com`. Whatever feeds the resolver
 * — an admission state, a stored "next" value, a module's answer — would
 * otherwise be an open-redirect surface on the one route that has just minted a
 * session.
 *
 * `%2f%2f` is deliberately NOT rejected: it stays a literal path segment
 * (measured), so refusing it would only break legitimate encoded paths.
 */
function isSameOriginPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2048 &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/**
 * The path to send a freshly signed-in member to.
 *
 * Falls back to `homePath` on every failure — no resolver, a throw, a timeout,
 * or an answer that is not a same-origin path — and says why at WARN, because a
 * silent fallback is indistinguishable from a resolver nobody wired up.
 */
async function landingFor(
  credential: string,
  homePath: string,
  resolve: ((credential: string) => string | Promise<string>) | undefined,
): Promise<string> {
  if (!resolve) return homePath;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      Promise.resolve(resolve(credential)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`landingPath did not answer in ${LANDING_TIMEOUT_MS}ms`)), LANDING_TIMEOUT_MS);
      }),
    ]);
    if (isSameOriginPath(answer)) return answer;
    console.warn(`[mirrorstack] landingPath returned an unusable path; using ${homePath}`, { answer });
    return homePath;
  } catch (error) {
    console.warn(`[mirrorstack] landingPath failed; using ${homePath}`, { error });
    return homePath;
  } finally {
    // Cleared whichever way the race settled: a pending timer keeps the
    // process (and a serverless invocation) alive for no reason.
    if (timer) clearTimeout(timer);
  }
}

function assertCookieName(value: string, label: string): string {
  if (typeof value !== "string" || !COOKIE_NAME_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a cookie name matching [A-Za-z0-9_-]{1,64}`);
  }
  return value;
}

function redirect(request: Request, path: string, status: 302 | 303 = 302): Response {
  return Response.redirect(new URL(path, request.url).toString(), status);
}

function failure(request: Request, loginPath: string, reason: string): Response {
  return redirect(request, `${loginPath}?error=${encodeURIComponent(reason)}`);
}

/**
 * Creates the three sign-in route handlers and the credential reader for one
 * custom application. Inputs are validated up front, like `platformBaseUrl`.
 */
/**
 * Report whether the BROWSER reached this app over HTTPS.
 *
 * 🔴 Not `new URL(request.url).protocol` alone. Behind a TLS-terminating proxy
 * — which is every production deployment of this framework — the request URL
 * carries the scheme of the INTERNAL hop, so it reads "http:" while the browser
 * is on HTTPS. Deriving `Secure` from it therefore ships the SESSION COOKIE
 * without the Secure attribute over a connection the user believes is
 * encrypted, and a cookie without Secure is sent on any later plaintext request
 * to the same host.
 *
 * `x-forwarded-proto` is what the proxy sets to say what the browser used, and
 * it is only ever consulted to ADD Secure, never to remove it: a forged header
 * cannot weaken the cookie, only harden it. A comma list ("https,http") keeps
 * the first hop, which is the browser's.
 *
 * @param request - The incoming route request.
 * @returns True when the cookie must carry `Secure`.
 */
function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded && forwarded.split(",")[0]!.trim().toLowerCase() === "https") {
    return true;
  }
  // Plain HTTP local development sets neither, and a `Secure` cookie cannot be
  // stored there — so the fallback stays the request's own scheme.
  return new URL(request.url).protocol === "https:";
}

export function createAuthRoutes(options: AuthRoutesOptions): AuthRoutes {
  if (options === null || typeof options !== "object") {
    throw new TypeError("createAuthRoutes options must be an object");
  }
  const provider = options.provider;
  if (provider === null || typeof provider !== "object" || typeof provider.startUrl !== "function") {
    throw new TypeError("provider must expose startUrl(provider, { redirect, handoffState })");
  }
  const sessions = memberSessions({
    apiUrl: options.apiUrl,
    appSlug: options.appSlug,
    fetch: options.fetch,
  });
  const handoffParam = options.handoffParam ?? DEFAULT_HANDOFF_PARAM;
  if (typeof handoffParam !== "string" || handoffParam.length === 0) {
    throw new TypeError("handoffParam must be a non-empty query parameter name");
  }
  const callbackPath = assertPath(options.paths?.callback ?? "/api/auth/callback", "paths.callback");
  const loginPath = assertPath(options.paths?.login ?? "/login", "paths.login");
  const homePath = assertPath(options.paths?.home ?? "/", "paths.home");
  const sessionCookie = assertCookieName(options.cookies?.session ?? DEFAULT_SESSION_COOKIE, "cookies.session");
  const stateCookie = assertCookieName(options.cookies?.state ?? DEFAULT_STATE_COOKIE, "cookies.state");
  const sessionMaxAge = options.cookies?.sessionMaxAgeSeconds ?? DEFAULT_SESSION_MAX_AGE;
  const stateMaxAge = options.cookies?.stateMaxAgeSeconds ?? DEFAULT_STATE_MAX_AGE;

  // Never `SameSite=None`: the return leg from the provider is a top-level GET
  // navigation, which Lax still carries.
  const cookieOptions = (request: Request, maxAge: number) => ({
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecureRequest(request),
    path: "/",
    maxAge,
  });

  async function readMemberCredential(): Promise<string | null> {
    const store = await cookies();
    return store.get(sessionCookie)?.value ?? null;
  }

  return {
    sessions,
    readMemberCredential,
    start: {
      async GET(request) {
        const slug = new URL(request.url).searchParams.get("provider") ?? "";
        if (!PROVIDER_SLUG_PATTERN.test(slug)) {
          return Response.json({ error: "provider is required" }, { status: 400 });
        }
        // The state is issued and stored in the SAME request that hands out
        // the URL carrying it, so the cookie and the URL cannot drift apart.
        const state = sessions.newState();
        const store = await cookies();
        store.set(stateCookie, state, cookieOptions(request, stateMaxAge));
        // The callback origin is the origin of THIS request, never a
        // configured value: the same build serves localhost and production,
        // and the provider's redirect allowlist is the guard against an
        // attacker-chosen origin.
        const redirectTo = new URL(callbackPath, request.url).toString();
        return redirect(request, provider.startUrl(slug, { redirect: redirectTo, handoffState: state }));
      },
    },
    callback: {
      async GET(request) {
        const code = new URL(request.url).searchParams.get(handoffParam);
        // Taken (and cleared) BEFORE anything is redeemed, so a replayed URL
        // finds nothing to match against. The provider echoes no state; the
        // binding is this cookie posted with the code, which the platform
        // refuses unless the pair matches the handoff it recorded.
        const store = await cookies();
        const issuedState = store.get(stateCookie)?.value ?? null;
        store.delete(stateCookie);
        if (!code) return failure(request, loginPath, "missing_code");
        if (!issuedState) return failure(request, loginPath, "expired");
        let credential: string;
        try {
          credential = (await sessions.exchange(code, issuedState)).credential;
        } catch {
          return failure(request, loginPath, "exchange_failed");
        }
        store.set(sessionCookie, credential, cookieOptions(request, sessionMaxAge));
        // The cookie is set BEFORE the landing is resolved, so a resolver that
        // is slow, throws, or answers nonsense costs the member a redirect
        // target and never the session they just earned.
        return redirect(request, await landingFor(credential, homePath, options.landingPath));
      },
    },
    logout: {
      async POST(request) {
        const store = await cookies();
        const credential = store.get(sessionCookie)?.value ?? null;
        if (credential) {
          // Forgetting the cookie is not a sign-out: the credential stays
          // valid on the platform until it expires. Clear only once the
          // platform no longer honours it; otherwise the member stays signed
          // in and is told, rather than shown a sign-out that did not happen.
          const outcome = await sessions.revoke(credential);
          if (outcome === "unavailable") {
            return redirect(request, `${homePath}?error=logout_unavailable`, 303);
          }
        }
        store.delete(sessionCookie);
        return redirect(request, loginPath, 303);
      },
    },
  };
}
