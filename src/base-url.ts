import { normalizeBaseUrl } from "./transport.js";

// The platform's APP slug rule, mirrored from api-platform
// internal/shared/slugs/slugs.go (`Format`): lowercase ASCII alphanumerics and
// hyphens, may start with a digit, 1-39 characters. This is distinct from the
// module catalog slug rule in plugin.ts (`[a-z][a-z0-9-]{0,15}`), which is
// narrower and applies to `moduleRef`, never to an app slug.
const APP_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}$/;

/** @internal */
export function assertAppSlug(appSlug: string): void {
  if (typeof appSlug !== "string" || !APP_SLUG_PATTERN.test(appSlug)) {
    throw new TypeError("appSlug must be a lowercase app slug matching [a-z0-9][a-z0-9-]{0,38}");
  }
}

/** Inputs for {@link platformBaseUrl}. */
export interface PlatformBaseUrlOptions {
  /** Absolute HTTP(S) platform API URL, typically `MIRRORSTACK_API_URL` (`https://api.<org-domain>`). */
  readonly apiUrl: string;
  /**
   * The custom application's slug, typically `MIRRORSTACK_APP_SLUG` — the app
   * slug shown in the console URL (`apps.mirrorstack.ai/apps/<slug>`).
   */
  readonly appSlug: string;
}

/**
 * Builds the `baseUrl` a custom web app passes to `createAppClient` when it
 * talks to the platform directly.
 *
 * The platform serves a custom app's installed modules at
 * `https://api.<org-domain>/v1/apps/app/<appSlug>/<scope>/<moduleRef>/<path>`,
 * so the app reads `MIRRORSTACK_API_URL` and `MIRRORSTACK_APP_SLUG` from its
 * environment and lets the client append `/<scope>/<moduleRef>/<path>`:
 *
 * ```ts
 * const client = createAppClient({
 *   baseUrl: platformBaseUrl({
 *     apiUrl: process.env.MIRRORSTACK_API_URL!,
 *     appSlug: process.env.MIRRORSTACK_APP_SLUG!,
 *   }),
 *   modules: { user: userCore() },
 * });
 * ```
 *
 * `apiUrl` must be an absolute HTTP(S) URL without credentials, a query, or a
 * fragment; trailing slashes are removed and any path prefix is preserved.
 * `appSlug` must be a lowercase app slug (`[a-z0-9][a-z0-9-]{0,38}`, the
 * platform's app rule — not the shorter module catalog slug rule). Both are
 * validated before any URL is composed, so a misconfigured environment fails
 * at startup rather than as a 404 on the first request.
 */
export function platformBaseUrl(options: PlatformBaseUrlOptions): string {
  if (options === null || typeof options !== "object") {
    throw new TypeError("platformBaseUrl options must be an object");
  }
  const { apiUrl, appSlug } = options;
  if (typeof apiUrl !== "string" || !/^https?:\/\//u.test(apiUrl)) {
    throw new TypeError("apiUrl must be an absolute HTTP(S) URL");
  }
  assertAppSlug(appSlug);
  return `${normalizeBaseUrl(apiUrl, "apiUrl")}/v1/apps/app/${appSlug}`;
}
