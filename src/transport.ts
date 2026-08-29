import {
  errorCodeFromResponse,
  moduleClientErrorFromResponse,
} from "./error.js";
import type { ModuleScope } from "./plugin.js";

/** A value that may be returned synchronously or asynchronously. */
export type Awaitable<T> = T | PromiseLike<T>;

/** Metadata carried to a request header provider but never sent by itself. */
export type RequestMetadata = Readonly<Record<string, unknown>>;

/** Scalar values accepted by the object form of {@link QueryParams}. */
export type QueryScalar = string | number | boolean | bigint | null | undefined;

/** Query parameters for a request or navigation URL. */
export type QueryParams =
  | URLSearchParams
  | Readonly<Record<string, QueryScalar | readonly QueryScalar[]>>;

/** Immutable information supplied to an asynchronous header provider. */
export interface ModuleRequestContext {
  readonly moduleRef: string;
  readonly scope: ModuleScope;
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly metadata: RequestMetadata;
}

/** Static headers or a per-request asynchronous header provider. */
export type RequestHeaders =
  | HeadersInit
  | ((context: ModuleRequestContext) => Awaitable<HeadersInit | undefined>);

/**
 * End-user access Bearer hooks used exclusively for platform-scope
 * `Authorization`. Never supply an `X-MS-*` token, delegation/member
 * assertion, signing secret, or internal credential here.
 */
export interface PlatformAuth {
  readonly getAccessToken: () => Awaitable<string | null>;
  readonly refreshAccessToken?: () => Awaitable<string | null>;
}

/** Successful response representation requested from the transport. */
export type ModuleResponseType = "json" | "text" | "response" | "void";

/** Maps a response representation to its resolved TypeScript type. */
export type ModuleResponse<T, TType extends ModuleResponseType> =
  TType extends "text"
    ? string
    : TType extends "response"
      ? Response
      : TType extends "void"
        ? void
        : T;

interface CommonOptions extends Omit<RequestInit, "body" | "headers" | "method" | "redirect"> {
  readonly headers?: HeadersInit;
  readonly query?: QueryParams;
  readonly metadata?: RequestMetadata;
}

type BodyOptions =
  | { readonly body?: BodyInit | null; readonly json?: never }
  | { readonly json: unknown; readonly body?: never };

/** Options for a raw scoped fetch. `json` and `body` are mutually exclusive. */
export type ScopedFetchOptions = CommonOptions &
  BodyOptions & {
    readonly method?: string;
  };

/** Options for a parsed module request. `json` and `body` are mutually exclusive. */
export type ModuleRequestOptions<TType extends ModuleResponseType = ModuleResponseType> =
  CommonOptions &
    BodyOptions & {
      /** Defaults to `json`. */
      readonly responseType?: TType;
    };

/** A transport permanently confined to one module and one public scope. */
export interface ScopedTransport {
  /** Builds a safe dispatch URL, including for top-level browser navigation. */
  url(path: string, query?: QueryParams): string;

  /** Performs a request and returns the raw response without HTTP-status parsing. */
  fetch(path: string, options?: ScopedFetchOptions): Promise<Response>;

  /** Performs a request, throwing {@link ModuleClientError} for non-2xx responses. */
  request<T = unknown, TType extends ModuleResponseType = "json">(
    method: string,
    path: string,
    options?: ModuleRequestOptions<TType>,
  ): Promise<ModuleResponse<T, TType>>;

  /** Performs a parsed GET request. */
  get<T = unknown, TType extends ModuleResponseType = "json">(
    path: string,
    options?: ModuleRequestOptions<TType>,
  ): Promise<ModuleResponse<T, TType>>;

  /** Performs a parsed POST request. */
  post<T = unknown, TType extends ModuleResponseType = "json">(
    path: string,
    options?: ModuleRequestOptions<TType>,
  ): Promise<ModuleResponse<T, TType>>;

  /** Performs a parsed PUT request. */
  put<T = unknown, TType extends ModuleResponseType = "json">(
    path: string,
    options?: ModuleRequestOptions<TType>,
  ): Promise<ModuleResponse<T, TType>>;

  /** Performs a parsed PATCH request. */
  patch<T = unknown, TType extends ModuleResponseType = "json">(
    path: string,
    options?: ModuleRequestOptions<TType>,
  ): Promise<ModuleResponse<T, TType>>;

  /** Performs a parsed DELETE request. */
  delete<T = unknown, TType extends ModuleResponseType = "json">(
    path: string,
    options?: ModuleRequestOptions<TType>,
  ): Promise<ModuleResponse<T, TType>>;
}

/** @internal */
export interface SharedTransportConfig {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly headers?: RequestHeaders;
  readonly credentials: RequestCredentials;
  readonly metadata?: RequestMetadata;
  readonly platformAuth?: PlatformAuth;
}

const HTTP_METHOD_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HEADER_PREFIX = "x-ms-";
const REFRESHABLE_CODES = new Set(["token_expired", "token_missing"]);
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const RESPONSE_TYPES = new Set<ModuleResponseType>(["json", "text", "response", "void"]);

function own(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertSafePath(path: string): void {
  if (typeof path !== "string" || (path !== "" && !path.startsWith("/"))) {
    throw new TypeError('module request path must be empty or start with "/"');
  }
  if (path.includes("?") || path.includes("#")) {
    throw new TypeError("put query parameters in the query option, not in path");
  }

  let layer = path;
  for (let depth = 0; depth < 8; depth += 1) {
    if (/\\|[\u0000-\u001f\u007f]/u.test(layer) || layer.includes("//")) {
      throw new TypeError("module request path contains an unsafe separator");
    }
    const segments = layer.split("/");
    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw new TypeError("module request path must not contain dot segments");
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(layer);
    } catch {
      throw new TypeError("module request path contains invalid percent encoding");
    }
    if (decoded === layer) return;
    if ((decoded.match(/\//g)?.length ?? 0) !== (layer.match(/\//g)?.length ?? 0)) {
      throw new TypeError("module request path must not contain encoded separators");
    }
    if (decoded.includes("?") || decoded.includes("#")) {
      throw new TypeError("module request path must not contain encoded query or fragment markers");
    }
    layer = decoded;
  }
  throw new TypeError("module request path is excessively percent encoded");
}

function normalizeBaseUrl(baseUrl: string): string {
  if (typeof baseUrl !== "string" || baseUrl === "" || baseUrl.includes("\\")) {
    throw new TypeError("baseUrl must be a non-empty HTTP(S) URL or root-relative path");
  }
  if (/^https?:\/\//u.test(baseUrl)) {
    const parsed = new URL(baseUrl);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new TypeError("baseUrl must not contain credentials, a query, or a fragment");
    }
    const authority = `${parsed.protocol}//${parsed.host}`;
    const rawPath = baseUrl.slice(authority.length) || "/";
    assertSafePath(rawPath);
    return baseUrl.replace(/\/+$/u, "");
  }
  if (!baseUrl.startsWith("/") || baseUrl.startsWith("//")) {
    throw new TypeError("relative baseUrl must be root-relative");
  }
  assertSafePath(baseUrl);
  return baseUrl.replace(/\/+$/u, "");
}

function queryString(query: QueryParams | undefined): string {
  if (query === undefined) return "";
  if (query instanceof URLSearchParams) return query.toString();

  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value === null || value === undefined) continue;
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError(`query parameter ${key} must be finite`);
      }
      if (!["string", "number", "boolean", "bigint"].includes(typeof value)) {
        throw new TypeError(`query parameter ${key} has an unsupported value`);
      }
      params.append(key, String(value));
    }
  }
  return params.toString();
}

function normalizeMethod(method: string | undefined): string {
  const normalized = method === undefined ? "GET" : method.toUpperCase();
  if (!HTTP_METHOD_PATTERN.test(normalized)) {
    throw new TypeError("request method must be a valid HTTP token");
  }
  return normalized;
}

function validateHeaders(headers: Headers, source: string): void {
  for (const name of headers.keys()) {
    if (name.toLowerCase().startsWith(RESERVED_HEADER_PREFIX)) {
      throw new TypeError(`${source} must not set reserved ${RESERVED_HEADER_PREFIX}* headers`);
    }
  }
}

function snapshotHeaders(value: HeadersInit, source: string): Headers {
  const headers = new Headers(value);
  validateHeaders(headers, source);
  return headers;
}

function mergeMetadata(
  defaults: RequestMetadata | undefined,
  request: RequestMetadata | undefined,
): RequestMetadata {
  const result = Object.assign(Object.create(null) as Record<string, unknown>, defaults, request);
  return Object.freeze(result);
}

function serializeBody(options: Record<string, unknown>): {
  readonly body: BodyInit | null | undefined;
  readonly isJson: boolean;
} {
  const hasJson = own(options, "json");
  const hasBody = own(options, "body") && options.body !== undefined;
  if (hasJson && hasBody) {
    throw new TypeError("request options cannot contain both json and body");
  }
  if (!hasJson) {
    return { body: options.body as BodyInit | null | undefined, isJson: false };
  }
  const body = JSON.stringify(options.json);
  if (body === undefined) {
    throw new TypeError("json must be JSON-serializable");
  }
  return { body, isJson: true };
}

function isReplayableBody(body: BodyInit | null | undefined): boolean {
  if (body === null || body === undefined || typeof body === "string") return true;
  if (body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return true;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  return false;
}

function addBearer(headers: Headers, token: string | null): void {
  headers.delete("authorization");
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
}

function requireAccessToken(token: string | null, operation: string): string {
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error(`platformAuth.${operation} returned no access token`);
  }
  return token;
}

async function parseSuccess<T, TType extends ModuleResponseType>(
  response: Response,
  responseType: TType,
): Promise<ModuleResponse<T, TType>> {
  switch (responseType) {
    case "response":
      return response as ModuleResponse<T, TType>;
    case "text":
      return (await response.text()) as ModuleResponse<T, TType>;
    case "void":
      return undefined as ModuleResponse<T, TType>;
    case "json": {
      const text = await response.text();
      if (text === "") {
        throw new SyntaxError(
          'expected a JSON response body; use responseType: "void" for an empty response',
        );
      }
      return JSON.parse(text) as ModuleResponse<T, TType>;
    }
  }
}

function assertResponseType(responseType: unknown): asserts responseType is ModuleResponseType {
  if (!RESPONSE_TYPES.has(responseType as ModuleResponseType)) {
    throw new TypeError("responseType must be json, text, response, or void");
  }
}

/** @internal */
export function createScopedTransports(
  config: SharedTransportConfig,
  moduleRef: string,
  moduleBaseUrl?: string,
  scopePaths: Partial<Record<"public" | "platform", string>> = {},
): Readonly<Record<ModuleScope, ScopedTransport>> {
  const moduleBase =
    moduleBaseUrl === undefined
      ? `${normalizeBaseUrl(config.baseUrl)}/${encodeURIComponent(moduleRef)}`
      : moduleBaseUrl === ""
        ? ""
        : normalizeBaseUrl(moduleBaseUrl);
  const staticHeaders =
    typeof config.headers === "function" || config.headers === undefined
      ? undefined
      : snapshotHeaders(config.headers, "configured headers");
  const headerProvider = typeof config.headers === "function" ? config.headers : undefined;

  function makeScope(scope: ModuleScope): ScopedTransport {
    const scopePath = scopePaths[scope] ?? scope;
    const scopeBase = scopePath ? `${moduleBase}/${scopePath}` : moduleBase;

    function url(path: string, query?: QueryParams): string {
      assertSafePath(path);
      const serialized = queryString(query);
      return `${scopeBase}${path}${serialized === "" ? "" : `?${serialized}`}`;
    }

    async function rawFetch(path: string, options: ScopedFetchOptions = {}): Promise<Response> {
      const optionRecord = options as unknown as Record<string, unknown>;
      if (own(optionRecord, "redirect")) {
        throw new TypeError(
          "scoped module requests do not accept redirect overrides; redirects are blocked",
        );
      }
      const method = normalizeMethod(options.method);
      const requestUrl = url(path, options.query);
      const metadata = mergeMetadata(config.metadata, options.metadata);
      const context = Object.freeze({ moduleRef, scope, method, path, url: requestUrl, metadata });
      const provided = headerProvider === undefined ? undefined : await headerProvider(context);
      const providerHeaders =
        provided === undefined ? undefined : snapshotHeaders(provided, "header provider");
      const callerHeaders =
        options.headers === undefined ? undefined : snapshotHeaders(options.headers, "request headers");
      const headers = new Headers();
      const { body, isJson } = serializeBody(optionRecord);
      if (isJson) headers.set("content-type", "application/json");
      for (const source of [staticHeaders, providerHeaders, callerHeaders]) {
        source?.forEach((value, name) => headers.set(name, value));
      }
      if (scope === "platform" && headers.has("authorization")) {
        throw new TypeError(
          "platform requests must use platformAuth; configured, provider, and caller Authorization headers are rejected",
        );
      }

      const {
        body: _body,
        headers: _headers,
        json: _json,
        metadata: _metadata,
        method: _method,
        query: _query,
        redirect: _redirect,
        ...requestInit
      } = optionRecord;
      let token: string | null = null;
      if (scope === "platform" && config.platformAuth !== undefined) {
        token = requireAccessToken(
          await config.platformAuth.getAccessToken(),
          "getAccessToken",
        );
        addBearer(headers, token);
      }
      const init: RequestInit = {
        ...(requestInit as RequestInit),
        method,
        headers,
        body,
        credentials: options.credentials ?? config.credentials,
        // Following a module-controlled redirect could carry cookies or a
        // platform Bearer outside this module/scope URL.
        redirect: "error",
      };
      let response = await config.fetch(requestUrl, init);

      if (
        scope !== "platform" ||
        response.status !== 401 ||
        config.platformAuth?.refreshAccessToken === undefined ||
        !RETRYABLE_METHODS.has(method) ||
        !isReplayableBody(body) ||
        options.signal?.aborted === true
      ) {
        return response;
      }
      const code = await errorCodeFromResponse(response.clone());
      if (code === undefined || !REFRESHABLE_CODES.has(code)) return response;

      await response.body?.cancel();

      token = requireAccessToken(
        await config.platformAuth.refreshAccessToken(),
        "refreshAccessToken",
      );
      const retryHeaders = new Headers(headers);
      addBearer(retryHeaders, token);
      response = await config.fetch(requestUrl, { ...init, headers: retryHeaders });
      return response;
    }

    async function request<T = unknown, TType extends ModuleResponseType = "json">(
      method: string,
      path: string,
      options: ModuleRequestOptions<TType> = {},
    ): Promise<ModuleResponse<T, TType>> {
      const { responseType = "json" as TType, ...fetchOptions } = options;
      assertResponseType(responseType);
      const response = await rawFetch(path, { ...fetchOptions, method } as ScopedFetchOptions);
      if (!response.ok) {
        throw await moduleClientErrorFromResponse(response, { moduleRef, scope, path });
      }
      return parseSuccess<T, TType>(response, responseType);
    }

    const transport: ScopedTransport = {
      url,
      fetch: rawFetch,
      request,
      get: (path, options) => request("GET", path, options),
      post: (path, options) => request("POST", path, options),
      put: (path, options) => request("PUT", path, options),
      patch: (path, options) => request("PATCH", path, options),
      delete: (path, options) => request("DELETE", path, options),
    };
    return Object.freeze(transport);
  }

  return Object.freeze({ public: makeScope("public"), platform: makeScope("platform") });
}
