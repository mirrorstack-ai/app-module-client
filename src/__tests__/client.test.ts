import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  MODULE_CLIENT_API_VERSION,
  createAppClient,
  defineModuleClient,
  type ModuleClientContext,
  type ScopedTransport,
} from "../index.js";

const noopFetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

describe("module plugin composition", () => {
  it("preserves each explicitly composed plugin API type", () => {
    interface Asset {
      id: string;
      title: string;
    }

    const assets = defineModuleClient({
      moduleRef: "asset-library",
      create({ public: publicScope, platform }) {
        expectTypeOf(publicScope).toEqualTypeOf<ScopedTransport>();
        expectTypeOf(platform).toEqualTypeOf<ScopedTransport>();
        return {
          getAsset: (id: string) => publicScope.get<Asset>(`/assets/${id}`),
          updateAsset: (id: string, title: string) =>
            platform.patch<Asset>(`/assets/${id}`, { json: { title } }),
        };
      },
    });
    const audit = defineModuleClient({
      moduleRef: "audit-log",
      create({ platform }) {
        return { exportUrl: () => platform.url("/export", { format: "csv" }) };
      },
    });

    const client = createAppClient({
      baseUrl: "/v1/apps/app/demo",
      modules: { assets, audit },
      fetch: noopFetch,
    });

    expectTypeOf(client.modules.assets).toEqualTypeOf<{
      getAsset: (id: string) => Promise<Asset>;
      updateAsset: (id: string, title: string) => Promise<Asset>;
    }>();
    expectTypeOf(client.modules.audit.exportUrl).returns.toEqualTypeOf<string>();
    expect(client.modules.audit.exportUrl()).toBe(
      "/v1/apps/app/demo/platform/audit-log/export?format=csv",
    );
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(client.modules)).toBe(true);
    expect(Object.isFrozen(assets)).toBe(true);
  });

  it("exposes only public and platform transports to plugins", () => {
    let observed: ModuleClientContext | undefined;
    const plugin = defineModuleClient({
      moduleRef: "safe-module",
      create(context) {
        observed = context;
        // @ts-expect-error Internal routes are deliberately absent from the client contract.
        expect(context.internal).toBeUndefined();
        return {};
      },
    });

    createAppClient({ baseUrl: "/modules", modules: { safe: plugin }, fetch: noopFetch });
    expect(Object.keys(observed ?? {}).sort()).toEqual(["platform", "public"]);
  });

  it("marks plugins with API version 1 and rejects incompatible runtime objects", () => {
    const plugin = defineModuleClient({ moduleRef: "sample-module", create: () => ({}) });
    expect(plugin.apiVersion).toBe(MODULE_CLIENT_API_VERSION);

    const incompatible = { ...plugin, apiVersion: 2 } as unknown as typeof plugin;
    expect(() =>
      createAppClient({ baseUrl: "/modules", modules: { incompatible }, fetch: noopFetch }),
    ).toThrow(/unsupported client API version 2/u);
  });

  it("detects duplicate module references before creating any APIs", () => {
    const create = vi.fn(() => ({}));
    const first = defineModuleClient({ moduleRef: "sample-module", create });
    const second = defineModuleClient({ moduleRef: "sample-module", create });

    expect(() =>
      createAppClient({
        baseUrl: "/modules",
        modules: { primary: first, duplicate: second },
        fetch: noopFetch,
      }),
    ).toThrow("duplicate moduleRef registration: sample-module");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("module references", () => {
  it.each([
    "a",
    "ab",
    "abc",
    "user-core",
    "user-core-",
    `a${"b".repeat(15)}`,
    "a722a8a8-d413-435b-b21b-f4cbacb5ef73",
  ])("accepts catalog ref %s", (moduleRef) => {
    expect(() => defineModuleClient({ moduleRef, create: () => ({}) })).not.toThrow();
  });

  it.each([
    "",
    "1user-core",
    "User-core",
    "user_core",
    "module_sdk_id",
    "../user-core",
    "user/core",
    "user\\core",
    "user.core",
    `a${"b".repeat(16)}`,
    "A722A8A8-D413-435B-B21B-F4CBACB5EF73",
  ])("rejects non-catalog or path-like ref %j", (moduleRef) => {
    expect(() => defineModuleClient({ moduleRef, create: () => ({}) })).toThrow(TypeError);
  });
});

describe("safe URL construction", () => {
  function publicTransport(baseUrl = "/v1/apps/app/demo") {
    return createAppClient({
      baseUrl,
      modules: {
        test: defineModuleClient({
          moduleRef: "sample-module",
          create: ({ public: publicScope }) => publicScope,
        }),
      },
      fetch: noopFetch,
    }).modules.test;
  }

  it("preserves relative and absolute base prefixes and encodes query values", () => {
    expect(
      publicTransport("/edge/v1/apps/app/demo/").url("/directory", {
        q: "Ada Lovelace",
        tag: ["admin", "a/b"],
        page: 2,
        archived: false,
        omitted: undefined,
      }),
    ).toBe(
      "/edge/v1/apps/app/demo/public/sample-module/directory?q=Ada+Lovelace&tag=admin&tag=a%2Fb&page=2&archived=false",
    );
    expect(
      publicTransport("https://api.example.test/prefix/").url("/me", new URLSearchParams("x=1")),
    ).toBe("https://api.example.test/prefix/public/sample-module/me?x=1");
  });

  it.each([
    "me",
    "/users?admin=true",
    "/users#platform",
    "/../platform/users",
    "/%2e%2e/platform/users",
    "/%252e%252e/platform/users",
    "//platform/users",
    "/users//platform",
    "/users%2f..%2fplatform",
    "/users%255c..%255cplatform",
    "/%zz",
  ])("rejects unsafe or ambiguous path %j", (path) => {
    expect(() => publicTransport().url(path)).toThrow(TypeError);
  });

  it.each([
    "",
    "relative/modules",
    "//evil.example/modules",
    "ftp://api.example.test/modules",
    "https://user:secret@api.example.test/modules",
    "https://api.example.test/modules?token=secret",
    "/modules/../other",
  ])("rejects unsafe base URL %j", (baseUrl) => {
    expect(() => publicTransport(baseUrl)).toThrow(TypeError);
  });
});
