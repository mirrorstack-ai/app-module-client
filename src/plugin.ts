import type { ScopedTransport } from "./transport.js";

/** The plugin contract version understood by this package. */
export const MODULE_CLIENT_API_VERSION = 1 as const;

/** A module HTTP surface that browser and server applications may call. */
export type ModuleScope = "public" | "platform";

/** Transports provided to a module plugin while its typed API is created. */
export interface ModuleClientContext {
  /** Anonymous or module-defined-auth endpoints. */
  readonly public: ScopedTransport;
  /** MirrorStack platform-authenticated endpoints. */
  readonly platform: ScopedTransport;
}

/** A statically composed module client plugin. */
export interface ModuleClientPlugin<TApi = unknown> {
  /** Runtime compatibility marker. */
  readonly apiVersion: typeof MODULE_CLIENT_API_VERSION;
  /** Canonical 1-16 character catalog slug or UUID used as the dispatch segment. */
  readonly moduleRef: string;
  /** Creates the module-specific API from its two allowed transports. */
  readonly create: (context: ModuleClientContext) => TApi;
}

/** Definition accepted by {@link defineModuleClient}. */
export interface ModuleClientDefinition<TApi> {
  /** Canonical 1-16 character catalog slug or UUID; never the Go SDK `Config.ID`. */
  readonly moduleRef: string;
  /** Creates the public typed surface exposed at `client.modules.<alias>`. */
  readonly create: (context: ModuleClientContext) => TApi;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Mirrors the Go module SDK's canonical 1-16 byte catalog slug contract.
const CATALOG_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;

/** @internal */
export function assertModuleRef(moduleRef: string): void {
  if (
    typeof moduleRef !== "string" ||
    (!UUID_PATTERN.test(moduleRef) && !CATALOG_SLUG_PATTERN.test(moduleRef))
  ) {
    throw new TypeError(
      "moduleRef must be a lowercase catalog slug or UUID (not the module SDK Config.ID)",
    );
  }
}

/**
 * Defines a module plugin while preserving the return type of `create`.
 *
 * The explicit definition is the only discovery mechanism: importing a plugin
 * never mutates a registry or changes another application client.
 */
export function defineModuleClient<TApi>(
  definition: ModuleClientDefinition<TApi>,
): ModuleClientPlugin<TApi> {
  if (definition === null || typeof definition !== "object") {
    throw new TypeError("module client definition must be an object");
  }
  assertModuleRef(definition.moduleRef);
  if (typeof definition.create !== "function") {
    throw new TypeError("module client definition requires a create function");
  }

  return Object.freeze({
    apiVersion: MODULE_CLIENT_API_VERSION,
    moduleRef: definition.moduleRef,
    create: definition.create,
  });
}
