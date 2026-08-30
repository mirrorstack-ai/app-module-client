import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const react = vi.hoisted(() => ({
  createElement: vi.fn((type: unknown, props: unknown, ...children: unknown[]) => ({
    type,
    props,
    children,
  })),
  strictMode: Symbol("StrictMode"),
}));
const reactDOM = vi.hoisted(() => ({
  render: vi.fn(),
  unmount: vi.fn(),
  createRoot: vi.fn(),
}));

vi.mock("react", () => ({
  StrictMode: react.strictMode,
  createElement: react.createElement,
  useEffect: vi.fn(),
  useState: vi.fn(),
}));
vi.mock("react-dom/client", () => ({
  createRoot: reactDOM.createRoot,
}));

import { mountReactSurface } from "../web/react.js";

class FakeStyleElement {
  textContent: string | null = null;
  parent: FakeHead | undefined;

  remove() {
    this.parent?.remove(this);
  }
}

class FakeHead {
  readonly children: FakeStyleElement[] = [];

  appendChild(element: FakeStyleElement) {
    element.parent = this;
    this.children.push(element);
    return element;
  }

  remove(element: FakeStyleElement) {
    const index = this.children.indexOf(element);
    if (index !== -1) this.children.splice(index, 1);
    element.parent = undefined;
  }
}

class FakeDocument {
  readonly head = new FakeHead();

  createElement(name: string) {
    assert.equal(name, "style");
    return new FakeStyleElement();
  }
}

class FakeTarget {
  readonly attributes = new Map<string, string>();

  constructor(readonly ownerDocument = new FakeDocument()) {}

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
}

beforeEach(() => {
  reactDOM.createRoot.mockReturnValue({
    render: reactDOM.render,
    unmount: reactDOM.unmount,
  });
});

test("React mounting scopes styles and restores the previous mount marker", () => {
  const target = new FakeTarget();
  target.setAttribute("data-ms-mount", "previous-module");
  const element = { type: "App" };
  const disposeRuntime = vi.fn();

  const cleanup = mountReactSurface(target as unknown as HTMLElement, {
    moduleSlug: "user-core",
    styles: ".module { color: red; }",
    element: element as never,
    dispose: disposeRuntime,
  });

  assert.equal(target.getAttribute("data-ms-mount"), "user-core");
  assert.equal(reactDOM.createRoot.mock.calls[0]?.[0], target);
  assert.equal(reactDOM.render.mock.calls.length, 1);
  const tree = reactDOM.render.mock.calls[0]?.[0] as {
    type: unknown;
    children: unknown[];
  };
  assert.equal(tree.type, react.strictMode);
  assert.deepEqual(tree.children, [element]);
  assert.equal(target.ownerDocument.head.children.length, 1);
  assert.equal(
    target.ownerDocument.head.children[0]?.textContent,
    ".module { color: red; }",
  );

  cleanup();
  cleanup();
  assert.equal(reactDOM.unmount.mock.calls.length, 1);
  assert.equal(disposeRuntime.mock.calls.length, 1);
  assert.equal(target.getAttribute("data-ms-mount"), "previous-module");
  assert.equal(target.ownerDocument.head.children.length, 0);
});

test("concurrent mounts share one stylesheet until the final cleanup", () => {
  const ownerDocument = new FakeDocument();
  const firstTarget = new FakeTarget(ownerDocument);
  const secondTarget = new FakeTarget(ownerDocument);
  const options = {
    moduleSlug: "user-core",
    styles: ".module { color: red; }",
    element: { type: "App" } as never,
  };

  const cleanupFirst = mountReactSurface(
    firstTarget as unknown as HTMLElement,
    options,
  );
  const cleanupSecond = mountReactSurface(
    secondTarget as unknown as HTMLElement,
    options,
  );

  assert.equal(ownerDocument.head.children.length, 1);
  cleanupFirst();
  assert.equal(ownerDocument.head.children.length, 1);
  cleanupSecond();
  assert.equal(ownerDocument.head.children.length, 0);
});

test("cleanup disposes and restores the marker even when React unmount fails", () => {
  const target = new FakeTarget();
  const disposeRuntime = vi.fn();
  reactDOM.unmount.mockImplementationOnce(() => {
    throw new Error("unmount failed");
  });
  const cleanup = mountReactSurface(target as unknown as HTMLElement, {
    moduleSlug: "user-core",
    element: { type: "App" } as never,
    dispose: disposeRuntime,
  });

  assert.throws(cleanup, /unmount failed/);
  assert.equal(disposeRuntime.mock.calls.length, 1);
  assert.equal(target.hasAttribute("data-ms-mount"), false);
  cleanup();
  assert.equal(reactDOM.unmount.mock.calls.length, 1);
});

test("a failed render releases mount-local resources before rethrowing", () => {
  const target = new FakeTarget();
  target.setAttribute("data-ms-mount", "previous-module");
  const disposeRuntime = vi.fn();
  reactDOM.render.mockImplementationOnce(() => {
    throw new Error("render failed");
  });

  assert.throws(() => mountReactSurface(target as unknown as HTMLElement, {
    moduleSlug: "user-core",
    element: { type: "App" } as never,
    dispose: disposeRuntime,
  }), /render failed/);
  assert.equal(reactDOM.unmount.mock.calls.length, 1);
  assert.equal(disposeRuntime.mock.calls.length, 1);
  assert.equal(target.getAttribute("data-ms-mount"), "previous-module");
  assert.equal(target.ownerDocument.head.children.length, 0);
});

test("a failed concurrent mount releases only its stylesheet reference", () => {
  const ownerDocument = new FakeDocument();
  const firstTarget = new FakeTarget(ownerDocument);
  const cleanupFirst = mountReactSurface(firstTarget as unknown as HTMLElement, {
    moduleSlug: "user-core",
    styles: ".module { color: red; }",
    element: { type: "App" } as never,
  });
  reactDOM.render.mockImplementationOnce(() => {
    throw new Error("render failed");
  });

  assert.throws(() => mountReactSurface(
    new FakeTarget(ownerDocument) as unknown as HTMLElement,
    {
      moduleSlug: "user-core",
      styles: ".module { color: red; }",
      element: { type: "App" } as never,
    },
  ), /render failed/);
  assert.equal(ownerDocument.head.children.length, 1);

  cleanupFirst();
  assert.equal(ownerDocument.head.children.length, 0);
});
