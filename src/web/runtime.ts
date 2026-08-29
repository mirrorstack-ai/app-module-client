import { createScopedTransports } from "../transport.js";
import type { PlatformFetch } from "./types.js";

/** Options for an API request made by a mounted module web surface. */
export interface ModuleWebRequestOptions {
  body?: unknown;
  headers?: HeadersInit;
  query?: Record<string, boolean | number | string | null | undefined>;
  signal?: AbortSignal;
}

/** Configuration owned by the host at module mount time. */
export interface CreateModuleWebTransportOptions {
  moduleRef: string;
  apiBase?: string;
  appId?: string;
  fetch?: PlatformFetch;
}

/** Direct module transport for public-root and platform-scoped routes. */
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
  transports: ReturnType<typeof createScopedTransports>,
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
 * Creates a transport for code already mounted inside one module.
 *
 * Unlike createAppClient(), apiBase is the module API root. Public routes are
 * rooted directly there; platform routes use apiBase/platform.
 */
export function createModuleWebTransport(
  options: CreateModuleWebTransportOptions,
): ModuleWebTransport {
  let apiBase = options.apiBase ?? "";
  while (apiBase.endsWith("/")) apiBase = apiBase.slice(0, -1);
  const hostFetch = options.fetch;

  const contextualFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!hostFetch) {
      throw new Error(
        "Module " + options.moduleRef + " cannot request data before the host supplies fetch.",
      );
    }

    const headers = new Headers(init?.headers);
    if (options.appId) headers.set("X-MS-App-ID", options.appId);
    return hostFetch(input, { ...init, headers });
  }) as typeof globalThis.fetch;

  const transports = createScopedTransports(
    {
      baseUrl: apiBase,
      fetch: contextualFetch,
      credentials: "include",
    },
    options.moduleRef,
    apiBase,
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
