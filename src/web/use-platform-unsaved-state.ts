import { useEffect } from "react";

import type { PlatformUnsaved, UnsavedBarState } from "./types.js";

const latestRegistration = new WeakMap<PlatformUnsaved, symbol>();

/**
 * Synchronizes one React surface with its platform-owned unsaved-state bridge.
 *
 * State updates replace the current value directly. The hook sends `null` only
 * when the caller supplies it, the bridge changes, or the final owner unmounts.
 * Cleanup is deferred by one microtask so React Strict Mode's effect replay
 * cannot emit a false transient clear between identical registrations.
 */
export function usePlatformUnsavedState(
  bridge: PlatformUnsaved | undefined,
  state: UnsavedBarState | null,
): void {
  useEffect(() => {
    if (bridge === undefined) return;
    const registration = Symbol("platform-unsaved-state");
    latestRegistration.set(bridge, registration);

    return () => {
      queueMicrotask(() => {
        if (latestRegistration.get(bridge) !== registration) return;
        latestRegistration.delete(bridge);
        try {
          bridge.set(null);
        } catch {
          // A cleanup failure cannot be reported safely from a deferred effect.
        }
      });
    };
  }, [bridge]);

  useEffect(() => {
    bridge?.set(state);
  }, [bridge, state]);
}
