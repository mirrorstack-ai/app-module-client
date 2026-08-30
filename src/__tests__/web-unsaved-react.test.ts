import { expect, test, vi } from "vitest";

import type { PlatformUnsaved, UnsavedBarState } from "../web/types.js";

type EffectCleanup = void | (() => void);
type EffectCallback = () => EffectCleanup;

interface PendingEffect {
  callback: EffectCallback;
  deps: readonly unknown[];
}

const react = vi.hoisted(() => ({
  pending: [] as PendingEffect[],
}));

vi.mock("react", () => ({
  useEffect(callback: EffectCallback, deps: readonly unknown[]) {
    react.pending.push({ callback, deps });
  },
}));

import { usePlatformUnsavedState } from "../web/use-platform-unsaved-state.js";

function sameDeps(first: readonly unknown[], second: readonly unknown[]): boolean {
  return first.length === second.length
    && first.every((value, index) => Object.is(value, second[index]));
}

class HookHost {
  private active: Array<PendingEffect & { cleanup: EffectCleanup }> = [];

  render(bridge: PlatformUnsaved | undefined, state: UnsavedBarState | null) {
    react.pending.length = 0;
    usePlatformUnsavedState(bridge, state);
    const next = react.pending.splice(0);
    const active: Array<PendingEffect & { cleanup: EffectCleanup }> = [];

    next.forEach((effect, index) => {
      const previous = this.active[index];
      if (previous !== undefined && sameDeps(previous.deps, effect.deps)) {
        active.push({ ...effect, cleanup: previous.cleanup });
        return;
      }
      previous?.cleanup?.();
      active.push({ ...effect, cleanup: effect.callback() });
    });
    for (let index = next.length; index < this.active.length; index += 1) {
      this.active[index]?.cleanup?.();
    }
    this.active = active;
  }

  replayEffects() {
    for (const effect of this.active) effect.cleanup?.();
    this.active = this.active.map((effect) => ({
      ...effect,
      cleanup: effect.callback(),
    }));
  }

  unmount() {
    for (const effect of this.active) effect.cleanup?.();
    this.active = [];
  }
}

const firstState: UnsavedBarState = {
  message: "Unsaved",
  saveLabel: "Save",
  resetLabel: "Reset",
  onSave: () => {},
  onReset: () => {},
};
const savingState: UnsavedBarState = {
  ...firstState,
  canSave: false,
};

async function flushCleanups() {
  await Promise.resolve();
}

test("state changes never emit a transient null, including effect replay", async () => {
  const set = vi.fn();
  const bridge = { set };
  const host = new HookHost();

  host.render(bridge, firstState);
  host.replayEffects();
  await flushCleanups();
  expect(set.mock.calls.some(([value]) => value === null)).toBe(false);

  const callsBeforeUpdate = set.mock.calls.length;
  host.render(bridge, savingState);
  expect(set.mock.calls.slice(callsBeforeUpdate)).toEqual([[savingState]]);
});

test("explicit null clears immediately and a later state can replace it", () => {
  const set = vi.fn();
  const bridge = { set };
  const host = new HookHost();
  host.render(bridge, firstState);

  host.render(bridge, null);
  expect(set).toHaveBeenLastCalledWith(null);

  host.render(bridge, savingState);
  expect(set).toHaveBeenLastCalledWith(savingState);
});

test("changing bridges clears the old bridge without clearing the new one", async () => {
  const firstSet = vi.fn();
  const secondSet = vi.fn();
  const firstBridge = { set: firstSet };
  const secondBridge = { set: secondSet };
  const host = new HookHost();
  host.render(firstBridge, firstState);

  host.render(secondBridge, savingState);
  await flushCleanups();
  expect(firstSet).toHaveBeenLastCalledWith(null);
  expect(secondSet.mock.calls).toEqual([[savingState]]);
});

test("unmount clears the current bridge once the replay window closes", async () => {
  const set = vi.fn();
  const host = new HookHost();
  host.render({ set }, firstState);
  host.replayEffects();
  await flushCleanups();

  host.unmount();
  await flushCleanups();
  expect(set).toHaveBeenLastCalledWith(null);
  expect(set.mock.calls.filter(([value]) => value === null)).toHaveLength(1);
});
