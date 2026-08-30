import { useEffect, useState } from "react";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Returns wall-clock time refreshed on a configurable, document-independent cadence.
 *
 * The default is suitable for relative timestamps and expiry labels that do
 * not need second-level precision.
 */
export function useNow(intervalMs = 30_000): number {
  if (
    !Number.isSafeInteger(intervalMs)
    || intervalMs <= 0
    || intervalMs > MAX_TIMER_DELAY_MS
  ) {
    throw new TypeError(
      `useNow intervalMs must be an integer from 1 to ${MAX_TIMER_DELAY_MS}`,
    );
  }

  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), intervalMs);
    return () => globalThis.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
