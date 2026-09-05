import { assertCatalogSlug } from "./plugin.js";
import { normalizeBaseUrl } from "./transport.js";

/** Inputs for {@link platformBaseUrl}. */
export interface PlatformBaseUrlOptions {
  /** Absolute HTTP(S) platform API URL, typically `MIRRORSTACK_API_URL` (`https://api.<org-domain>`). */
  readonly apiUrl: string;
  /** The custom application's slug, typically `MIRRORSTACK_APP_SLUG`. */
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
 * `appSlug` must be a lowercase catalog slug. Both are validated before any
 * URL is composed, so a misconfigured environment fails at startup rather than
 * as a 404 on the first request.
 */
export function platformBaseUrl(options: PlatformBaseUrlOptions): string {
  if (options === null || typeof options !== "object") {
    throw new TypeError("platformBaseUrl options must be an object");
  }
  const { apiUrl, appSlug } = options;
  if (typeof apiUrl !== "string" || !/^https?:\/\//u.test(apiUrl)) {
    throw new TypeError("apiUrl must be an absolute HTTP(S) URL");
  }
  assertCatalogSlug(appSlug, "appSlug");
  return `${normalizeBaseUrl(apiUrl, "apiUrl")}/v1/apps/app/${appSlug}`;
}
