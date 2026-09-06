/**
 * Next.js App Router adapter for a custom web app's sign-in: ready-made
 * start / callback / logout route handlers over HttpOnly cookies, on top of
 * the platform member-session control plane in `./server`.
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
