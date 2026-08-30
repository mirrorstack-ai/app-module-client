import { StrictMode, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

export { usePlatformUnsavedState } from "./use-platform-unsaved-state.js";
export { useNow } from "./use-now.js";

interface StylesheetRegistration {
  element: HTMLStyleElement;
  references: number;
}

const stylesheetsByDocument = new WeakMap<
  Document,
  Map<string, StylesheetRegistration>
>();

function retainStylesheet(document: Document, styles: string): () => void {
  let stylesheets = stylesheetsByDocument.get(document);
  if (stylesheets === undefined) {
    stylesheets = new Map();
    stylesheetsByDocument.set(document, stylesheets);
  }

  let registration = stylesheets.get(styles);
  if (registration === undefined) {
    const element = document.createElement("style");
    element.textContent = styles;
    document.head.appendChild(element);
    registration = { element, references: 0 };
    stylesheets.set(styles, registration);
  }
  registration.references += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    registration.references -= 1;
    if (registration.references !== 0) return;

    registration.element.remove();
    stylesheets.delete(styles);
    if (stylesheets.size === 0) {
      stylesheetsByDocument.delete(document);
    }
  };
}

/** Configuration for mounting one React-owned module surface. */
export interface MountReactSurfaceOptions {
  /** Catalog slug written to the host element for module-scoped styling. */
  moduleSlug: string;
  /** Compiled module CSS retained once per document while any mount uses it. */
  styles?: string;
  /** React content owned by the mounted module. */
  element: ReactElement;
  /** Releases mount-local resources after React unmounts. */
  dispose?: () => void;
}

/**
 * Mounts one isolated React surface and returns an idempotent cleanup function.
 */
export function mountReactSurface(
  target: HTMLElement,
  options: MountReactSurfaceOptions,
): () => void {
  const hadMount = target.hasAttribute("data-ms-mount");
  const previousMount = target.getAttribute("data-ms-mount");
  const restoreMount = () => {
    if (hadMount && previousMount !== null) {
      target.setAttribute("data-ms-mount", previousMount);
    } else {
      target.removeAttribute("data-ms-mount");
    }
  };
  target.setAttribute("data-ms-mount", options.moduleSlug);

  let root: ReturnType<typeof createRoot> | undefined;
  let releaseStylesheet: (() => void) | undefined;
  try {
    if (options.styles !== undefined) {
      releaseStylesheet = retainStylesheet(target.ownerDocument, options.styles);
    }
    root = createRoot(target);
    root.render(createElement(StrictMode, null, options.element));
  } catch (error) {
    try {
      root?.unmount();
    } catch {
      // Preserve the original mount error after best-effort cleanup.
    }
    try {
      options.dispose?.();
    } catch {
      // Preserve the original mount error after best-effort cleanup.
    }
    try {
      releaseStylesheet?.();
    } catch {
      // Preserve the original mount error after best-effort cleanup.
    }
    try {
      restoreMount();
    } catch {
      // Preserve the original mount error after best-effort cleanup.
    }
    throw error;
  }
  const mountedRoot = root;

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    try {
      mountedRoot.unmount();
    } finally {
      try {
        options.dispose?.();
      } finally {
        try {
          releaseStylesheet?.();
        } finally {
          restoreMount();
        }
      }
    }
  };
}
