import { assertModuleRef, type ModuleClientContext } from "../plugin.js";
import { resolveMaxResponseBytes } from "../response.js";
import { createScopedTransports } from "../transport.js";
import type { PlatformFetch } from "./types.js";

/** Configuration owned by the host at module mount time. */
export interface CreateModuleWebTransportsOptions {
  /** Canonical 1-16 character catalog slug or UUID used for routing and diagnostics. */
  readonly moduleRef: string;
  /** Dispatch root for this mounted module. Empty means same-origin. */
  readonly apiBase?: string;
  /** Authenticated fetch capability supplied by the platform host. */
  readonly fetch?: PlatformFetch;
  /** Maximum bytes parsed from response bodies. Defaults to one mebibyte. */
  readonly maxResponseBytes?: number;
}

/** Public-root and platform-scoped transports for one mounted module. */
export type ModuleWebTransports = ModuleClientContext;

/**
 * Creates full public and platform transports for one mounted module.
 *
 * The host-provided fetch owns authentication and application identity.
 * Browser module code cannot select trusted `X-MS-*` identity headers.
 */
function composeWebTransports(
  options: CreateModuleWebTransportsOptions,
  scopePaths: Partial<Record<"public" | "platform", string>>,
): ModuleWebTransports {
  assertModuleRef(options.moduleRef);
  let apiBase = options.apiBase ?? "";
  while (apiBase.endsWith("/")) apiBase = apiBase.slice(0, -1);
  const hostFetch = options.fetch;

  const contextualFetch: typeof globalThis.fetch = async (input, init) => {
    if (!hostFetch) {
      throw new Error(
        "Module " + options.moduleRef + " cannot request data before the host supplies fetch.",
      );
    }
    return hostFetch(input, init);
  };

  return createScopedTransports(
    {
      baseUrl: apiBase,
      fetch: contextualFetch,
      credentials: "include",
      maxResponseBytes: resolveMaxResponseBytes(options.maxResponseBytes),
    },
    options.moduleRef,
    apiBase,
    scopePaths,
  );
}

export function createModuleWebTransports(
  options: CreateModuleWebTransportsOptions,
): ModuleWebTransports {
  // The Go SDK mounts each scope under its own name — ms.Public routes live at
  // /public/ — so the public scope owns that segment exactly as platform owns
  // /platform/. A module must never have to spell it in the path it requests.
  return composeWebTransports(options, { public: "public", platform: "platform" });
}

/**
 * Options for an API request made through the v0.1.0 compatibility transport.
 *
 * @deprecated Prefer the complete scoped request options exposed by
 * `createModuleWebTransports()`.
 */
export interface ModuleWebRequestOptions {
  body?: unknown;
  headers?: HeadersInit;
  query?: Record<string, boolean | number | string | null | undefined>;
  signal?: AbortSignal;
}

/**
 * Configuration for the v0.1.0 compatibility transport.
 *
 * `appId` remains accepted for source compatibility but is informational.
 * It is never converted into a trusted `X-MS-App-ID` browser header.
 *
 * @deprecated Prefer {@link CreateModuleWebTransportsOptions}.
 */
export interface CreateModuleWebTransportOptions {
  moduleRef: string;
  apiBase?: string;
  appId?: string;
  fetch?: PlatformFetch;
}

/**
 * Direct v0.1.0 module transport for public-root and platform-scoped routes.
 *
 * @deprecated Prefer {@link ModuleWebTransports}.
 */
export interface ModuleWebTransport {
  /** Sends a request and parses a successful JSON body. */
  request<T>(method: string, route: string, options?: ModuleWebRequestOptions): Promise<T>;

  /** Sends a request and returns its successful body as text. */
  text(method: string, route: string, options?: ModuleWebRequestOptions): Promise<string>;
}

type RequestInvoker = (
  method: string,
  path: string,
  options?: Record<string, unknown>,
) => Promise<unknown>;

function routeTarget(
  route: string,
  transports: ModuleWebTransports,
) {
  if (route === "/platform") {
    return { path: "/", transport: transports.platform };
  }
  if (route.startsWith("/platform/")) {
    return { path: route.slice("/platform".length), transport: transports.platform };
  }
  return { path: route, transport: transports.public };
}

/**
 * Creates the direct route-dispatching transport released in v0.1.0.
 *
 * @deprecated Prefer {@link createModuleWebTransports}, which keeps public and
 * platform routes structurally separate and exposes the full scoped contract.
 */
export function createModuleWebTransport(
  options: CreateModuleWebTransportOptions,
): ModuleWebTransport {
  // This transport is documented as serving "public-root and platform-scoped
  // routes": its callers pass whole paths, including the /public segment and
  // root-level routes. It therefore keeps addressing the module ROOT, and does
  // not inherit the /public segment createModuleWebTransports now owns.
  const transports = composeWebTransports(
    {
      moduleRef: options.moduleRef,
      ...(options.apiBase === undefined ? {} : { apiBase: options.apiBase }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    },
    { public: "", platform: "platform" },
  );

  const invoke = async <T>(
    method: string,
    route: string,
    requestOptions: ModuleWebRequestOptions | undefined,
    responseType: "json" | "text",
  ): Promise<T> => {
    const target = routeTarget(route, transports);
    const request = target.transport.request as unknown as RequestInvoker;
    return request(method, target.path, {
      ...requestOptions,
      responseType,
    }) as Promise<T>;
  };

  return Object.freeze({
    request: <T>(
      method: string,
      route: string,
      requestOptions?: ModuleWebRequestOptions,
    ) => invoke<T>(method, route, requestOptions, "json"),
    text: (
      method: string,
      route: string,
      requestOptions?: ModuleWebRequestOptions,
    ) => invoke<string>(method, route, requestOptions, "text"),
  });
}
