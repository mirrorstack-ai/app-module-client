import {
  MODULE_CLIENT_API_VERSION,
  assertModuleRef,
  type ModuleClientPlugin,
} from "./plugin.js";
import { resolveMaxResponseBytes } from "./response.js";
import {
  createScopedTransports,
  type PlatformAuth,
  type RequestHeaders,
  type RequestMetadata,
  type SharedTransportConfig,
} from "./transport.js";

/** A named set of explicitly imported module plugins. */
export type ModulePluginMap = Readonly<Record<string, ModuleClientPlugin<unknown>>>;

/** Resolves the API created by one module plugin. */
export type ModuleApi<TPlugin> =
  TPlugin extends ModuleClientPlugin<infer TApi> ? TApi : never;

/** The immutable application client returned by {@link createAppClient}. */
export interface AppClient<TModules extends ModulePluginMap> {
  /** Typed APIs keyed by the aliases supplied in `modules`. */
  readonly modules: Readonly<{
    [TKey in keyof TModules]: ModuleApi<TModules[TKey]>;
  }>;
}

/** Configuration for {@link createAppClient}. */
export interface CreateAppClientOptions<TModules extends ModulePluginMap> {
  /**
   * App dispatch root; the client appends `/<scope>/<moduleRef>/<path>`.
   * Use `platformBaseUrl(...)` (`https://api.<org-domain>/v1/apps/app/<appSlug>`)
   * for a direct platform connection, or a same-origin BFF path.
   */
  readonly baseUrl: string;
  /** Explicit plugin composition; no package is discovered dynamically. */
  readonly modules: TModules;
  /** Fetch implementation, useful for SSR and tests. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Static headers or an async provider invoked for each logical request. */
  readonly headers?: RequestHeaders;
  /**
   * The signed-in member's credential, sent as `Authorization: Bearer` on
   * PUBLIC scope only.
   *
   * 🔴 Use this rather than putting the credential in `headers`. A configured
   * header applies to every scope, and platform scope rejects a configured
   * Authorization outright — so an app with a signed-in member would be unable
   * to call any platform method the moment a module client gained one. The
   * failure is a TypeError at request time, not a compile error, and it is
   * latent until the first platform-scope method exists.
   */
  readonly memberCredential?: string;
  /** Fetch credentials policy. Defaults to `include`. */
  readonly credentials?: RequestCredentials;
  /** Metadata made available to the header provider on every request. */
  readonly metadata?: RequestMetadata;
  /** Optional access-token lifecycle used only by platform-scope requests. */
  readonly platformAuth?: PlatformAuth;
  /** Maximum bytes parsed from response bodies. Defaults to one mebibyte. */
  readonly maxResponseBytes?: number;
}

function resolveFetch(fetchImplementation: typeof globalThis.fetch | undefined): typeof globalThis.fetch {
  if (fetchImplementation !== undefined) {
    if (typeof fetchImplementation !== "function") {
      throw new TypeError("fetch must be a function");
    }
    return fetchImplementation;
  }
  if (typeof globalThis.fetch !== "function") {
    throw new TypeError("globalThis.fetch is unavailable; provide a fetch implementation");
  }
  return globalThis.fetch.bind(globalThis);
}

function validatePlatformAuth(platformAuth: PlatformAuth | undefined): void {
  if (platformAuth === undefined) return;
  if (platformAuth === null || typeof platformAuth !== "object") {
    throw new TypeError("platformAuth must be an object");
  }
  if (typeof platformAuth.getAccessToken !== "function") {
    throw new TypeError("platformAuth.getAccessToken must be a function");
  }
  if (
    platformAuth.refreshAccessToken !== undefined &&
    typeof platformAuth.refreshAccessToken !== "function"
  ) {
    throw new TypeError("platformAuth.refreshAccessToken must be a function");
  }
}

/**
 * Creates an application client from an explicit object of module plugins.
 *
 * The object keys are local aliases and do not affect routing. A module
 * reference may occur only once so two aliases cannot silently address the
 * same installed module with different expectations.
 */
export function createAppClient<const TModules extends ModulePluginMap>(
  options: CreateAppClientOptions<TModules>,
): AppClient<TModules> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("application client options must be an object");
  }
  if (options.modules === null || typeof options.modules !== "object") {
    throw new TypeError("modules must be an object of module plugins");
  }
  validatePlatformAuth(options.platformAuth);

  const entries = Object.entries(options.modules) as [string, ModuleClientPlugin<unknown>][];
  const refs = new Set<string>();
  for (const [alias, plugin] of entries) {
    if (plugin === null || typeof plugin !== "object") {
      throw new TypeError(`module ${alias} is not a module client plugin`);
    }
    if (plugin.apiVersion !== MODULE_CLIENT_API_VERSION) {
      throw new TypeError(
        `module ${alias} uses unsupported client API version ${String(plugin.apiVersion)}`,
      );
    }
    assertModuleRef(plugin.moduleRef);
    if (typeof plugin.create !== "function") {
      throw new TypeError(`module ${alias} does not provide a create function`);
    }
    if (refs.has(plugin.moduleRef)) {
      throw new TypeError(`duplicate moduleRef registration: ${plugin.moduleRef}`);
    }
    refs.add(plugin.moduleRef);
  }

  const shared: SharedTransportConfig = {
    baseUrl: options.baseUrl,
    fetch: resolveFetch(options.fetch),
    credentials: options.credentials ?? "include",
    maxResponseBytes: resolveMaxResponseBytes(options.maxResponseBytes),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.memberCredential === undefined ? {} : { memberCredential: options.memberCredential }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    ...(options.platformAuth === undefined ? {} : { platformAuth: options.platformAuth }),
  };
  const modules = {} as { [TKey in keyof TModules]: ModuleApi<TModules[TKey]> };
  for (const [alias, plugin] of entries) {
    const api = plugin.create(createScopedTransports(shared, plugin.moduleRef));
    Object.defineProperty(modules, alias, {
      configurable: false,
      enumerable: true,
      value: api,
      writable: false,
    });
  }

  return Object.freeze({ modules: Object.freeze(modules) });
}
