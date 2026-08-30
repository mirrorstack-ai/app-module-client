/** Fetch implementation supplied by the authenticated platform host. */
export type PlatformFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Resolves platform actor identifiers for audit and attribution UI. */
export interface PlatformIdentity<TIdentity = unknown> {
  resolve: (ids: string[]) => Promise<Record<string, TIdentity>>;
}

/** Navigation bridge supplied by the platform shell. */
export interface PlatformNavigate {
  settings: () => void;
  /** Platform-resolved settings slot: this module first, followed by installed
   *  settings-capable modules that contribute to it. Optional for old hosts. */
  settingsItems?: PlatformSettingsItem[];
  openSettings?: (moduleSlug: string) => void;
  /** Opens one user in the platform-owned User Core detail surface. */
  userDetail?: (userId: string) => void;
}

/** Settings destination accepted by the platform navigation bridge. */
export interface PlatformSettingsItem {
  moduleSlug: string;
  label: string;
  icon: string;
}

/** State rendered by the platform unsaved-changes bar. */
export interface UnsavedBarState {
  message: string;
  saveLabel: string;
  resetLabel: string;
  /** Disables the save action while retaining reset and warning behavior. */
  canSave?: boolean;
  onSave: () => void;
  onReset: () => void;
}

/** Bridge used by a mounted module to control unsaved-change UI. */
export interface PlatformUnsaved {
  set: (state: UnsavedBarState | null) => void;
}

/** Event emitted from one mounted module component to another. */
export interface PlatformModuleComponentEvent {
  type: string;
  payload?: unknown;
}

/** Request to mount one component owned by an installed module. */
export type PlatformModuleMountRequest = {
  /** Manifest UI component name; the host resolves its declared bundle export. */
  component: string;
  target: HTMLElement;
  props?: Record<string, unknown>;
  onEvent?: (event: PlatformModuleComponentEvent) => void;
} & (
  | {
      /** Authoritative installed-module identity resolved by the platform. */
      moduleId: string;
      /** Optional display/routing hint; never authoritative when moduleId exists. */
      moduleSlug?: string;
    }
  | {
      moduleId?: undefined;
      /** @deprecated Supply the platform-resolved moduleId when the host supports it. */
      moduleSlug: string;
    }
);

/** Cross-module component mount bridge supplied by the platform. */
export interface PlatformModules {
  mount: (request: PlatformModuleMountRequest) => Promise<() => void>;
}

/** Breadcrumb metadata for a module-owned subpath. */
export interface SubpathCrumb {
  /** URL-safe route segment owned by the module. */
  segment: string;
  /** Human-readable label rendered by the platform breadcrumb. */
  label: string;
}

/** Router state passed to a mounted module surface. */
export interface ModuleSubpath {
  /** Returns the currently requested module-relative path segments. */
  get: () => string[];
  /** Publishes a new module-relative path and its breadcrumb labels. */
  set: (crumbs: SubpathCrumb[], opts?: { replace?: boolean }) => void;
  /** Subscribes to navigation initiated by the platform. */
  subscribe: (listener: (segments: string[]) => void) => () => void;
}

/** Complete framework-neutral contract supplied when a module web surface mounts. */
export interface ModuleMountContext<TIdentity = unknown> {
  /** Prefix for this module's HTTP routes; empty means same-origin. */
  apiBase?: string;
  /** Authenticated host transport, including platform token refresh. */
  fetch?: PlatformFetch;
  /**
   * Host-supplied application identifier for mount-local state and links.
   * Informational in browser code; never trusted as request identity.
   */
  appId?: string;
  /** Active BCP-47 locale, such as `en-US` or `zh-TW`. */
  locale?: string;
  /** Platform-owned cross-surface navigation helpers. */
  navigate?: PlatformNavigate;
  /** Bridge to the platform-owned unsaved-changes interface. */
  unsaved?: PlatformUnsaved;
  /** Bridge for mounting contributed components from installed modules. */
  modules?: PlatformModules;
  /** Platform-owned principal identity resolver. */
  identity?: PlatformIdentity<TIdentity>;
  /** Bridge for module-relative navigation and breadcrumbs. */
  subpath?: ModuleSubpath;
}

/** Backward-compatible concise name for the module mount contract. */
export type MountContext<TIdentity = unknown> = ModuleMountContext<TIdentity>;

/** Props and lifecycle events supplied to a manifest-declared component. */
export interface ModuleComponentBridge<
  TProps extends object = Record<string, unknown>,
  TEventPayload = unknown,
> {
  /** Props validated by the host against the component manifest. */
  readonly props: TProps;
  /** Emits a component lifecycle event to the surface that requested it. */
  emit: (type: string, payload?: TEventPayload) => void;
}

/**
 * Host context for one manifest-declared component mount.
 *
 * Component mounts always have resolved installation, transport, locale, and
 * settings navigation context. Optional page bridges remain inherited from
 * ModuleMountContext so a host can add them without changing this contract.
 */
export interface ModuleComponentMountContext<
  TProps extends object = Record<string, unknown>,
  TEventPayload = unknown,
  TIdentity = unknown,
> extends ModuleMountContext<TIdentity> {
  apiBase: string;
  fetch: PlatformFetch;
  /** Informational host application value; never trusted request identity. */
  appId: string;
  locale: string;
  navigate: Pick<PlatformNavigate, "settings">;
  component: ModuleComponentBridge<TProps, TEventPayload>;
}
