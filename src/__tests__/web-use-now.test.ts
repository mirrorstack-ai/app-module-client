import { afterEach, beforeEach, expect, test, vi } from "vitest";

type EffectCleanup = void | (() => void);
type EffectCallback = () => EffectCleanup;

const react = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  updates: [] as number[],
}));

vi.mock("react", () => ({
  useEffect(callback: EffectCallback) {
    react.effects.push(callback);
  },
  useState(initial: () => number) {
    return [initial(), (value: number) => react.updates.push(value)] as const;
  },
}));

import { useNow } from "../web/use-now.js";

beforeEach(() => {
  react.effects.length = 0;
  react.updates.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => {
  vi.useRealTimers();
});

test("uses the current time immediately and refreshes every 30 seconds by default", () => {
  expect(useNow()).toBe(1_000);
  const cleanup = react.effects[0]?.();

  vi.advanceTimersByTime(29_999);
  expect(react.updates).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(react.updates).toEqual([31_000]);

  cleanup?.();
  vi.advanceTimersByTime(30_000);
  expect(react.updates).toEqual([31_000]);
});

test("supports a custom document-independent interval", () => {
  expect(useNow(5_000)).toBe(1_000);
  react.effects[0]?.();

  vi.advanceTimersByTime(10_000);
  expect(react.updates).toEqual([6_000, 11_000]);
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
  "rejects invalid interval %s",
  (intervalMs) => {
    expect(() => useNow(intervalMs)).toThrow(
      /intervalMs must be an integer from 1 to 2147483647/u,
    );
    expect(react.effects).toHaveLength(0);
  },
);
