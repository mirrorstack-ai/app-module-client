/** Lifecycle state of one component contributed by another installed module. */
export type ModuleComponentMountStatus =
  | "mounting"
  | "ready"
  | "unavailable"
  | "disposed";

/** Mount operation invoked with a child owned by the target's document. */
export type ModuleComponentMountOperation = (
  target: HTMLElement,
) => (() => void) | PromiseLike<() => void>;

/** Observable lifecycle for one cross-module component mount. */
export interface ModuleComponentMount {
  /** Returns the stable current lifecycle state. */
  getSnapshot(): ModuleComponentMountStatus;
  /** Returns the mount failure retained for diagnostics, when unavailable. */
  getError(): unknown;
  /** Subscribes to lifecycle state changes. */
  subscribe(listener: () => void): () => void;
  /** Releases the contributed component and removes its document-owned child. */
  dispose(): void;
}

function promiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Mounts a contributed component into an isolated child of the supplied target.
 *
 * The returned observable reports asynchronous readiness without coupling the
 * lifecycle to React. A late successful mount is immediately disposed when its
 * owner has already gone away.
 */
export function mountModuleComponent(
  target: HTMLElement,
  mount: ModuleComponentMountOperation,
): ModuleComponentMount {
  const child = target.ownerDocument.createElement("div");
  target.replaceChildren(child);

  let status: ModuleComponentMountStatus = "mounting";
  let error: unknown;
  let cleanup: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const publish = (next: ModuleComponentMountStatus) => {
    if (status === next) return;
    status = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Observer failures must not interrupt mount cleanup or state changes.
      }
    }
  };
  const unavailable = (cause: unknown) => {
    if (status === "disposed") {
      child.remove();
      return;
    }
    error = cause;
    child.remove();
    publish("unavailable");
  };
  const mounted = (dispose: unknown) => {
    if (typeof dispose !== "function") {
      unavailable(new TypeError("module component mount must return a cleanup function"));
      return;
    }
    if (status === "disposed") {
      try {
        dispose();
      } catch (cause) {
        error = cause;
      } finally {
        child.remove();
      }
      return;
    }
    cleanup = dispose as () => void;
    publish("ready");
  };

  const controller: ModuleComponentMount = Object.freeze({
    getSnapshot: () => status,
    getError: () => error,
    subscribe(listener: () => void) {
      if (status === "disposed") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (status === "disposed") return;
      publish("disposed");
      listeners.clear();
      const dispose = cleanup;
      cleanup = undefined;
      try {
        dispose?.();
      } catch (cause) {
        error = cause;
        throw cause;
      } finally {
        child.remove();
      }
    },
  });

  let result: ReturnType<ModuleComponentMountOperation>;
  try {
    result = mount(child);
  } catch (cause) {
    unavailable(cause);
    return controller;
  }

  try {
    if (promiseLike(result)) {
      void Promise.resolve(result).then(mounted, unavailable);
    } else {
      mounted(result);
    }
  } catch (cause) {
    unavailable(cause);
  }
  return controller;
}
