const DEFAULT_MAX_AGE_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 64;

interface Entry {
  readonly text: string;
  readonly storedAt: number;
}

interface Inflight {
  readonly promise: Promise<string>;
  readonly controller: AbortController;
  waiters: number;
}

/** Configuration for one mount-scoped text cache. */
export interface ModuleTextCacheOptions {
  /** Default freshness window for cached responses. */
  readonly maxAgeMs?: number;
  /** Maximum number of completed responses retained by this instance. */
  readonly maxEntries?: number;
  /** Clock override for deterministic tests. */
  readonly now?: () => number;
}

/** Options for one cached read. */
export interface CachedTextOptions {
  readonly signal?: AbortSignal;
  /** Overrides the instance freshness window; zero forces a network read. */
  readonly maxAgeMs?: number;
}

/** A request cache owned and disposed by one mounted module instance. */
export interface ModuleTextCache {
  /** Returns a fresh cached response or coalesces an equivalent live request. */
  cachedText(
    key: string,
    fetchText: (signal: AbortSignal) => Promise<string>,
    options?: CachedTextOptions,
  ): Promise<string>;

  /** Removes completed entries, optionally restricted to a key prefix. */
  invalidate(prefix?: string): void;

  /** Removes completed entries and aborts every live request owned by this cache. */
  clear(): void;
}

/** Returns true when an error represents an aborted browser request. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Creates an isolated text cache for one module mount.
 *
 * The cache stores response text so each consumer can parse its own object. It
 * never uses browser storage and shares no state with another cache instance.
 */
export function createModuleTextCache(
  options: ModuleTextCacheOptions = {},
): ModuleTextCache {
  const maxAgeMs = nonNegative(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, "maxAgeMs");
  const maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries");
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Inflight>();

  function remember(key: string, text: string): void {
    entries.delete(key);
    entries.set(key, { text, storedAt: now() });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      entries.delete(oldest.value);
    }
  }

  function attach(key: string, shared: Inflight, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted === true) return Promise.reject(abortError());

    shared.waiters += 1;
    if (signal === undefined) {
      return shared.promise.finally(() => {
        shared.waiters -= 1;
      });
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      shared.waiters -= 1;
      if (shared.waiters === 0 && inflight.get(key) === shared) {
        inflight.delete(key);
        shared.controller.abort();
      }
    };

    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        release();
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      shared.promise.then(
        (text) => {
          signal.removeEventListener("abort", onAbort);
          release();
          resolve(text);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          release();
          reject(error);
        },
      );
    });
  }

  async function cachedText(
    key: string,
    fetchText: (signal: AbortSignal) => Promise<string>,
    readOptions: CachedTextOptions = {},
  ): Promise<string> {
    if (readOptions.signal?.aborted === true) return Promise.reject(abortError());
    const requestedMaxAge = nonNegative(
      readOptions.maxAgeMs ?? maxAgeMs,
      "options.maxAgeMs",
    );
    const hit = entries.get(key);
    if (hit !== undefined && requestedMaxAge > 0 && now() - hit.storedAt < requestedMaxAge) {
      return hit.text;
    }

    const live = inflight.get(key);
    if (live !== undefined) return attach(key, live, readOptions.signal);

    const controller = new AbortController();
    const shared = {
      controller,
      promise: Promise.resolve(""),
      waiters: 0,
    } satisfies Inflight;
    const request = fetchText(controller.signal).then(
      (text) => {
        if (inflight.get(key) === shared) inflight.delete(key);
        remember(key, text);
        return text;
      },
      (error: unknown) => {
        if (inflight.get(key) === shared) inflight.delete(key);
        throw error;
      },
    );
    Object.assign(shared, { promise: request });
    inflight.set(key, shared);
    return attach(key, shared, readOptions.signal);
  }

  function invalidate(prefix?: string): void {
    if (prefix === undefined) {
      entries.clear();
      return;
    }
    for (const key of entries.keys()) {
      if (key.startsWith(prefix)) entries.delete(key);
    }
  }

  function clear(): void {
    entries.clear();
    for (const pending of inflight.values()) pending.controller.abort();
    inflight.clear();
  }

  return Object.freeze({ cachedText, invalidate, clear });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}
