/**
 * Next.js App Router adapter for a custom web app: ready-made start /
 * callback / logout route handlers over HttpOnly cookies on top of the
 * platform member-session control plane in `./server`, plus the catch-all
 * module proxy the browser client talks through.
 *
 * Requires `next` (optional peer dependency).
 *
 * @packageDocumentation
 */

export {
  createAuthRoutes,
  type AuthProviderStart,
  type AuthRoutes,
  type AuthRoutesOptions,
} from "./auth-routes.js";

export {
  createModuleProxyRoutes,
  type ModuleProxyRoutes,
  type ModuleProxyRoutesOptions,
  type RouteContext,
} from "./module-proxy-routes.js";
