import type { ModuleSubpath, SubpathCrumb } from "./types.js";

/** Mount-local observable state synchronized with the platform subpath bridge. */
export interface ModuleSubpathStore {
  /** Returns the stable current segment snapshot. */
  getSnapshot(): readonly string[];
  /** Subscribes to snapshot changes. */
  subscribe(listener: () => void): () => void;
  /** Publishes breadcrumbs to the host and updates the local snapshot. */
  publish(crumbs: readonly SubpathCrumb[], opts?: { replace?: boolean }): void;
  /** Releases the host subscription and local listeners. */
  dispose(): void;
}

function snapshot(segments: readonly string[]): readonly string[] {
  return Object.freeze([...segments]);
}

function equal(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length
    && first.every((segment, index) => segment === second[index]);
}

/**
 * Creates subpath state isolated to one mounted module surface.
 *
 * Publishing updates local state even when the host does not echo its own
 * navigation event. Without a host bridge, the store remains useful as an
 * in-memory navigation source.
 */
export function createModuleSubpathStore(
  bridge?: ModuleSubpath,
): ModuleSubpathStore {
  let current = snapshot(bridge?.get() ?? []);
  let disposed = false;
  const listeners = new Set<() => void>();

  const update = (segments: readonly string[]) => {
    if (disposed || equal(current, segments)) return;
    current = snapshot(segments);
    for (const listener of listeners) listener();
  };
  const unsubscribe = bridge?.subscribe(update);

  return Object.freeze({
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(crumbs: readonly SubpathCrumb[], opts?: { replace?: boolean }) {
      if (disposed) return;
      bridge?.set([...crumbs], opts);
      update(crumbs.map(({ segment }) => segment));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      listeners.clear();
    },
  });
}
