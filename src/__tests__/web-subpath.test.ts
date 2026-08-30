import assert from "node:assert/strict";
import { test } from "vitest";

import { createModuleSubpathStore } from "../web/subpath.js";
import type { ModuleSubpath, SubpathCrumb } from "../web/types.js";

function bridge(initial: string[] = []) {
  let listener: ((segments: string[]) => void) | undefined;
  const publications: Array<{
    crumbs: SubpathCrumb[];
    opts: { replace?: boolean } | undefined;
  }> = [];
  let unsubscribed = false;
  const value: ModuleSubpath = {
    get: () => initial,
    set: (crumbs, opts) => publications.push({ crumbs, opts }),
    subscribe: (next) => {
      listener = next;
      return () => {
        unsubscribed = true;
      };
    },
  };
  return {
    value,
    publications,
    emit: (segments: string[]) => listener?.(segments),
    unsubscribed: () => unsubscribed,
  };
}

test("subpath stores seed from the host and keep stable snapshots", () => {
  const host = bridge(["users", "one"]);
  const store = createModuleSubpathStore(host.value);
  const first = store.getSnapshot();

  assert.deepEqual(first, ["users", "one"]);
  assert.equal(store.getSnapshot(), first);

  host.emit(["users", "one"]);
  assert.equal(store.getSnapshot(), first);
  host.emit(["users", "two"]);
  assert.deepEqual(store.getSnapshot(), ["users", "two"]);
});

test("publish always calls the host and synchronizes hosts that do not echo", () => {
  const host = bridge();
  const store = createModuleSubpathStore(host.value);
  let changes = 0;
  store.subscribe(() => {
    changes += 1;
  });
  const crumbs = [{ segment: "users", label: "Users" }];

  store.publish(crumbs, { replace: true });
  store.publish(crumbs, { replace: false });

  assert.deepEqual(host.publications, [
    { crumbs, opts: { replace: true } },
    { crumbs, opts: { replace: false } },
  ]);
  assert.deepEqual(store.getSnapshot(), ["users"]);
  assert.equal(changes, 1);
});

test("an absent bridge creates isolated in-memory stores", () => {
  const first = createModuleSubpathStore();
  const second = createModuleSubpathStore();
  first.publish([{ segment: "settings", label: "Settings" }]);

  assert.deepEqual(first.getSnapshot(), ["settings"]);
  assert.deepEqual(second.getSnapshot(), []);
});

test("dispose detaches the host and prevents later updates", () => {
  const host = bridge(["users"]);
  const store = createModuleSubpathStore(host.value);
  store.dispose();
  store.dispose();
  host.emit(["sessions"]);
  store.publish([{ segment: "settings", label: "Settings" }]);

  assert.equal(host.unsubscribed(), true);
  assert.deepEqual(store.getSnapshot(), ["users"]);
  assert.equal(host.publications.length, 0);
});
