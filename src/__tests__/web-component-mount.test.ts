import assert from "node:assert/strict";
import { test, vi } from "vitest";

import { mountModuleComponent } from "../web/component-mount.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

class FakeDocument {
  createElement() {
    return new FakeElement(this);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  parent: FakeElement | undefined;

  constructor(readonly ownerDocument: FakeDocument) {}

  append(child: FakeElement) {
    child.remove();
    child.parent = this;
    this.children.push(child);
  }

  replaceChildren(...children: FakeElement[]) {
    for (const child of this.children) child.parent = undefined;
    this.children.length = 0;
    for (const child of children) this.append(child);
  }

  remove() {
    if (this.parent === undefined) return;
    const index = this.parent.children.indexOf(this);
    if (index !== -1) this.parent.children.splice(index, 1);
    this.parent = undefined;
  }

  get childElementCount() {
    return this.children.length;
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }
}

function target(ownerDocument = new FakeDocument()): HTMLElement {
  return ownerDocument.createElement() as unknown as HTMLElement;
}

test("component mounts use an isolated child from the target owner document", () => {
  const foreignDocument = new FakeDocument();
  const mountTarget = target(foreignDocument);
  (mountTarget as unknown as FakeElement).append(foreignDocument.createElement());
  let mountedTarget: HTMLElement | undefined;
  const cleanup = vi.fn();

  const mount = mountModuleComponent(mountTarget, (child) => {
    mountedTarget = child;
    return cleanup;
  });

  assert.equal(mount.getSnapshot(), "ready");
  assert.equal(mount.getError(), undefined);
  assert.equal(mountedTarget?.ownerDocument, foreignDocument);
  assert.equal(mountTarget.childElementCount, 1);
  assert.equal(mountTarget.firstElementChild, mountedTarget);

  mount.dispose();
  mount.dispose();
  assert.equal(cleanup.mock.calls.length, 1);
  assert.equal(mountTarget.childElementCount, 0);
  assert.equal(mount.getSnapshot(), "disposed");
});

test("synchronous mount failures become unavailable and remove the child", () => {
  const mountTarget = target();
  const failure = new Error("mount failed");

  const mount = mountModuleComponent(mountTarget, () => {
    throw failure;
  });

  assert.equal(mount.getSnapshot(), "unavailable");
  assert.equal(mount.getError(), failure);
  assert.equal(mountTarget.childElementCount, 0);
  assert.doesNotThrow(() => mount.dispose());
});

test("asynchronous readiness and failure notify observable subscribers", async () => {
  const success = deferred<() => void>();
  const successMount = mountModuleComponent(target(), () => success.promise);
  const successListener = vi.fn();
  successMount.subscribe(successListener);

  success.resolve(() => {});
  await success.promise;
  await Promise.resolve();
  assert.equal(successMount.getSnapshot(), "ready");
  assert.equal(successListener.mock.calls.length, 1);

  const failure = deferred<() => void>();
  const failureTarget = target();
  const failureMount = mountModuleComponent(failureTarget, () => failure.promise);
  const failureListener = vi.fn();
  failureMount.subscribe(failureListener);
  const cause = new Error("bundle unavailable");

  failure.reject(cause);
  await failure.promise.catch(() => undefined);
  await Promise.resolve();
  assert.equal(failureMount.getSnapshot(), "unavailable");
  assert.equal(failureMount.getError(), cause);
  assert.equal(failureTarget.childElementCount, 0);
  assert.equal(failureListener.mock.calls.length, 1);
});

test("late successful mounts are disposed after their owner is gone", async () => {
  const pending = deferred<() => void>();
  const mountTarget = target();
  const cleanup = vi.fn();
  const mount = mountModuleComponent(mountTarget, () => pending.promise);
  const listener = vi.fn();
  mount.subscribe(listener);

  mount.dispose();
  assert.equal(mount.getSnapshot(), "disposed");
  assert.equal(mountTarget.childElementCount, 0);
  assert.equal(listener.mock.calls.length, 1);

  pending.resolve(cleanup);
  await pending.promise;
  await Promise.resolve();
  assert.equal(cleanup.mock.calls.length, 1);
  assert.equal(mount.getSnapshot(), "disposed");
  assert.equal(listener.mock.calls.length, 1);
});

test("late rejection is handled and cleanup failures still remove the child", async () => {
  const pending = deferred<() => void>();
  const lateTarget = target();
  const lateMount = mountModuleComponent(lateTarget, () => pending.promise);
  lateMount.dispose();
  pending.reject(new Error("late failure"));
  await pending.promise.catch(() => undefined);
  await Promise.resolve();
  assert.equal(lateMount.getSnapshot(), "disposed");

  const mountTarget = target();
  const mount = mountModuleComponent(mountTarget, () => () => {
    throw new Error("cleanup failed");
  });
  assert.throws(() => mount.dispose(), /cleanup failed/u);
  assert.equal(mountTarget.childElementCount, 0);
  assert.equal(mount.getSnapshot(), "disposed");
  assert.doesNotThrow(() => mount.dispose());
});

test("an invalid cleanup result fails closed", () => {
  const mountTarget = target();
  const mount = mountModuleComponent(mountTarget, (() => undefined) as never);

  assert.equal(mount.getSnapshot(), "unavailable");
  assert.match(String(mount.getError()), /cleanup function/u);
  assert.equal(mountTarget.childElementCount, 0);
});

test("a malformed thenable becomes unavailable instead of escaping", () => {
  const failure = new Error("then getter failed");
  const result = Object.defineProperty({}, "then", {
    get() {
      throw failure;
    },
  });
  const mount = mountModuleComponent(target(), (() => result) as never);

  assert.equal(mount.getSnapshot(), "unavailable");
  assert.equal(mount.getError(), failure);
});

test("a failing readiness observer cannot interrupt disposal", () => {
  const mountTarget = target();
  const pending = deferred<() => void>();
  const mount = mountModuleComponent(mountTarget, () => pending.promise);
  mount.subscribe(() => {
    throw new Error("observer failed");
  });

  assert.doesNotThrow(() => mount.dispose());
  assert.equal(mount.getSnapshot(), "disposed");
  assert.equal(mountTarget.childElementCount, 0);
});
